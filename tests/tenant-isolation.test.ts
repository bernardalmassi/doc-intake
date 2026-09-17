// Proves RLS keeps tenants apart and that the row-first upload flow holds,
// using only the publishable key and real signed-in sessions (never the
// service role), against the project in .env.test. It creates its own users,
// tenants, rows and files and removes them in afterAll via delete_tenant and
// delete_own_account.
//
// Every "cannot" assertion is paired with a check that the owner can still
// see the original data, so a test can't pass just because the setup failed
// or the data was never there.
//
// Each test user is signed up once per run and reused, to stay under
// Supabase Auth's sign-up rate limit.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_TEST_URL;
const publishableKey = process.env.SUPABASE_TEST_PUBLISHABLE_KEY;
const emailDomain = process.env.SUPABASE_TEST_EMAIL_DOMAIN || "example.com";

if (!url || !publishableKey) {
  throw new Error(
    "Set SUPABASE_TEST_URL and SUPABASE_TEST_PUBLISHABLE_KEY in .env.test (see .env.test.example).",
  );
}

const BUCKET = "documents";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// The project's minimum password length (set in the dashboard).
const MIN_PASSWORD_LENGTH = 15;
const runId = randomUUID().slice(0, 8);

type TestUser = { client: SupabaseClient; id: string; email: string };
type DocumentRow = {
  id: string;
  tenant_id: string;
  storage_path: string;
  status: string;
  size_bytes: number | null;
  mime_type: string | null;
  filename: string;
  uploaded_by: string | null;
};

const ROW_COLUMNS =
  "id, tenant_id, storage_path, status, size_bytes, mime_type, filename, uploaded_by";

function newClient() {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// A small but real-looking PDF, so the bucket's MIME check and the size
// check both see the kind of file the app accepts.
function pdfBlob(marker: string) {
  const body = `%PDF-1.4\n% doc-intake test ${marker}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
  return new Blob([body], { type: "application/pdf" });
}

async function signUpUser(label: string): Promise<TestUser> {
  const client = newClient();
  const email = `tenant-isolation-${label}-${runId}@${emailDomain}`;
  // 40 characters: over the 15 minimum, under Supabase's 72 maximum
  const password = `${randomUUID()}Aa1!`;
  expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`sign-up for user ${label} failed: ${error.message}`);
  if (!data.session || !data.user) {
    throw new Error(
      "sign-up returned no session: turn off email confirmation for the test project (Authentication > Sign In / Providers > Email).",
    );
  }
  return { client, id: data.user.id, email };
}

async function createTenant(user: TestUser, label: string): Promise<string> {
  const { data, error } = await user.client.rpc("create_tenant", {
    p_name: `Isolation ${label} ${runId}`,
    p_slug: `iso-${label}-${runId}`,
  });
  if (error) throw new Error(`create_tenant ${label} failed: ${error.message}`);
  return (data as { id: string }).id;
}

// Step 1 of the upload flow: the row. Only tenant_id and filename are sent.
async function createRow(user: TestUser, tenantId: string, filename: string) {
  const { data, error } = await user.client
    .from("documents")
    .insert({ tenant_id: tenantId, filename })
    .select(ROW_COLUMNS)
    .single<DocumentRow>();
  if (error) throw new Error(`creating a row in ${tenantId} failed: ${error.message}`);
  return data;
}

// Step 2: the bytes, to the row's path, never with upsert. cacheControl 0
// keeps Supabase's CDN from serving a deleted file until its TTL expires
// (the default is 3600 seconds).
function uploadTo(user: TestUser, path: string, blob: Blob) {
  return user.client.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false, cacheControl: "0" });
}

// Step 3: confirm.
function complete(user: TestUser, documentId: string) {
  return user.client.rpc("complete_document_upload", { p_document_id: documentId });
}

async function fullUpload(user: TestUser, tenantId: string, filename: string, blob: Blob) {
  const row = await createRow(user, tenantId, filename);
  const upload = await uploadTo(user, row.storage_path, blob);
  if (upload.error) throw new Error(`upload to ${row.storage_path} failed: ${upload.error.message}`);
  const done = await complete(user, row.id);
  if (done.error) throw new Error(`complete_document_upload failed: ${done.error.message}`);
  return { row, completed: done.data as DocumentRow };
}

async function readRow(user: TestUser, id: string) {
  const { data, error } = await user.client
    .from("documents")
    .select(ROW_COLUMNS)
    .eq("id", id)
    .maybeSingle<DocumentRow>();
  if (error) throw error;
  return data;
}

async function listFiles(user: TestUser, tenantId: string) {
  const { data, error } = await user.client.storage.from(BUCKET).list(tenantId);
  if (error) throw error;
  return data.map((f) => f.name).sort();
}

// Set in beforeAll; cleanup handles whatever got created before a failure.
let userA: TestUser | undefined;
let userB: TestUser | undefined;
let userD: TestUser | undefined; // member of C only; deletes their own account mid-run
let userDDeleted = false;
const ownedTenants: { owner: () => TestUser | undefined; id: string }[] = [];

let tenantA: string; // A owns it; B has no access
let tenantB: string; // B owns it
let tenantC: string; // A owns it; B joins as member, later admin, then is removed; D is a member
let documentA: string; // A's completed document in tenant A
let objectPathA: string;
const secretA = pdfBlob("tenant A secret");

// Rows in tenant C created during the tests, in the order they're made.
let docAinC: DocumentRow; // A's completed document in C; B later deletes it as admin
let rowBWithFile: DocumentRow; // B's row in C: file uploaded, never completed
let rowBNoFile: DocumentRow; // B's row in C: no file ever uploaded
let docDinC: DocumentRow; // D's completed document in C; outlives D's account

// Non-null accessors so tests fail loudly if setup didn't finish.
const a = () => userA!;
const b = () => userB!;
const d = () => userD!;

beforeAll(async () => {
  userA = await signUpUser("a");
  userB = await signUpUser("b");
  userD = await signUpUser("d");

  tenantA = await createTenant(a(), "a");
  ownedTenants.push({ owner: () => userA, id: tenantA });
  tenantB = await createTenant(b(), "b");
  ownedTenants.push({ owner: () => userB, id: tenantB });
  tenantC = await createTenant(a(), "c");
  ownedTenants.push({ owner: () => userA, id: tenantC });

  const { row } = await fullUpload(a(), tenantA, "secret.pdf", secretA);
  documentA = row.id;
  objectPathA = row.storage_path;

  const join = await a().client
    .from("memberships")
    .insert({ tenant_id: tenantC, user_id: b().id, role: "member" });
  if (join.error) throw new Error(`adding B to tenant C failed: ${join.error.message}`);

  const joinD = await a().client
    .from("memberships")
    .insert({ tenant_id: tenantC, user_id: d().id, role: "member" });
  if (joinD.error) throw new Error(`adding D to tenant C failed: ${joinD.error.message}`);
  docDinC = (await fullUpload(d(), tenantC, "d-in-c.pdf", pdfBlob("from D in C"))).completed;
});

afterAll(async () => {
  const problems: string[] = [];

  // Storage objects first: a row can't be deleted while its file exists,
  // delete_tenant refuses while files remain, and SQL can't delete them.
  for (const user of [userA, userB]) {
    if (!user) continue;
    for (const { owner, id } of ownedTenants) {
      if (owner() !== user) continue;
      const { data: files, error: listError } = await user.client.storage
        .from(BUCKET)
        .list(id);
      if (listError) {
        problems.push(`list files in ${id}: ${listError.message}`);
        continue;
      }
      if (files.length > 0) {
        const { error } = await user.client.storage
          .from(BUCKET)
          .remove(files.map((f) => `${id}/${f.name}`));
        if (error) problems.push(`remove files in ${id}: ${error.message}`);
      }
    }
  }

  // Deleting a tenant cascades its memberships and documents rows.
  for (const { owner, id } of ownedTenants) {
    const user = owner();
    if (!user) continue;
    const { error } = await user.client.rpc("delete_tenant", { p_tenant_id: id });
    if (error) problems.push(`delete_tenant ${id}: ${error.message}`);
  }

  for (const user of [userA, userB, userDDeleted ? undefined : userD]) {
    if (!user) continue;
    const { error } = await user.client.rpc("delete_own_account");
    if (error) problems.push(`delete_own_account ${user.email}: ${error.message}`);
  }

  if (problems.length > 0) {
    throw new Error(`cleanup left data behind:\n${problems.join("\n")}`);
  }
});

describe("tenant rows", () => {
  it("B cannot read tenant A, its memberships or its documents", async () => {
    const tenants = await b().client.from("tenants").select("id").eq("id", tenantA);
    const memberships = await b().client
      .from("memberships")
      .select("id")
      .eq("tenant_id", tenantA);
    const documents = await b().client
      .from("documents")
      .select("id")
      .eq("tenant_id", tenantA);

    expect(tenants.error).toBeNull();
    expect(tenants.data).toEqual([]);
    expect(memberships.error).toBeNull();
    expect(memberships.data).toEqual([]);
    expect(documents.error).toBeNull();
    expect(documents.data).toEqual([]);

    // control: the rows exist and A can see them
    const own = await a().client.from("documents").select("id").eq("tenant_id", tenantA);
    expect(own.data).toEqual([{ id: documentA }]);
  });

  it("B's unfiltered queries return only B's own tenants", async () => {
    const { data, error } = await b().client.from("tenants").select("id");
    expect(error).toBeNull();
    const ids = (data ?? []).map((t) => t.id).sort();
    expect(ids).toEqual([tenantB, tenantC].sort());
  });

  it("B cannot insert a document with tenant A's tenant_id", async () => {
    const { data, error } = await b().client
      .from("documents")
      .insert({ tenant_id: tenantA, filename: "injected.pdf" })
      .select("id");

    expect(data).toBeNull();
    expect(error?.code).toBe("42501");

    const own = await a().client.from("documents").select("id").eq("tenant_id", tenantA);
    expect(own.data).toEqual([{ id: documentA }]);
  });

  it("B cannot update or delete tenant A's document", async () => {
    const updated = await b().client
      .from("documents")
      .update({ filename: "pwned.pdf" })
      .eq("id", documentA)
      .select("id");
    expect(updated.data ?? []).toEqual([]);

    const deleted = await b().client
      .from("documents")
      .delete()
      .eq("id", documentA)
      .select("id");
    expect(deleted.data ?? []).toEqual([]);

    const own = await a().client
      .from("documents")
      .select("filename")
      .eq("id", documentA)
      .single();
    expect(own.data).toEqual({ filename: "secret.pdf" });
  });

  it("B cannot rename tenant A", async () => {
    const { data } = await b().client
      .from("tenants")
      .update({ name: "pwned" })
      .eq("id", tenantA)
      .select("id");
    expect(data ?? []).toEqual([]);

    const own = await a().client.from("tenants").select("name").eq("id", tenantA).single();
    expect(own.data?.name).toBe(`Isolation a ${runId}`);
  });

  it("B cannot delete tenant A through the RPC", async () => {
    const { error } = await b().client.rpc("delete_tenant", { p_tenant_id: tenantA });
    expect(error?.code).toBe("42501");

    const own = await a().client.from("tenants").select("id").eq("id", tenantA);
    expect(own.data).toEqual([{ id: tenantA }]);
  });
});

describe("document rows", () => {
  it("a member can insert only tenant_id and filename", async () => {
    // Each of these is rejected by the column grant (42501) before RLS.
    // storage_path is a generated column, which Postgres refuses to insert
    // into at all (428C9) before it even gets to privileges.
    const forbidden: [Record<string, unknown>, string][] = [
      [{ status: "pending" }, "42501"],
      [{ storage_path: `${tenantA}/chosen-by-client.pdf` }, "428C9"],
      [{ size_bytes: 1 }, "42501"],
      [{ mime_type: "application/pdf" }, "42501"],
      [{ uploaded_by: a().id }, "42501"],
    ];
    for (const [extra, code] of forbidden) {
      const { data, error } = await a().client
        .from("documents")
        .insert({ tenant_id: tenantA, filename: "extra.pdf", ...extra })
        .select("id");
      expect(data, JSON.stringify(extra)).toBeNull();
      expect(error?.code, JSON.stringify(extra)).toBe(code);
    }

    const own = await a().client.from("documents").select("id").eq("tenant_id", tenantA);
    expect(own.data).toEqual([{ id: documentA }]);
  });

  it("filename must be 1 to 255 characters with no control characters", async () => {
    const bad = ["", "   ", "a".repeat(256), "line\nbreak.pdf", "tab\tname.pdf", "esc\u001b.pdf"];
    for (const filename of bad) {
      const { data, error } = await a().client
        .from("documents")
        .insert({ tenant_id: tenantA, filename })
        .select("id");
      expect(data, JSON.stringify(filename)).toBeNull();
      expect(error?.code, JSON.stringify(filename)).toBe("23514");
    }

    // control: the longest allowed name is accepted
    const row = await createRow(a(), tenantA, "a".repeat(255));
    expect(row.filename).toHaveLength(255);
  });

  it("storage_path is exactly <tenant_id>/<id> and a new row starts as 'uploading'", async () => {
    const existing = await readRow(a(), documentA);
    expect(existing?.storage_path).toBe(`${tenantA}/${documentA}`);

    const row = await createRow(a(), tenantA, "fresh.pdf");
    expect(row.storage_path).toBe(`${tenantA}/${row.id}`);
    expect(row.status).toBe("uploading");
    expect(row.size_bytes).toBeNull();
    expect(row.mime_type).toBeNull();
    // never uploaded; the row is removed by the tenant cascade in cleanup
  });

  it("a member cannot update status but can rename", async () => {
    const status = await a().client
      .from("documents")
      .update({ status: "extracted" })
      .eq("id", documentA)
      .select("id");
    expect(status.data).toBeNull();
    expect(status.error?.code).toBe("42501");

    const renamed = await a().client
      .from("documents")
      .update({ filename: "secret-renamed.pdf" })
      .eq("id", documentA)
      .select("filename, status")
      .single();
    expect(renamed.error).toBeNull();
    expect(renamed.data).toEqual({ filename: "secret-renamed.pdf", status: "pending" });

    // put it back for later assertions
    await a().client.from("documents").update({ filename: "secret.pdf" }).eq("id", documentA);
    expect((await readRow(a(), documentA))?.filename).toBe("secret.pdf");
  });
});

describe("upload flow", () => {
  it("a completed upload records the real byte count and type", async () => {
    const blob = pdfBlob("size check " + "x".repeat(517));
    const { row, completed } = await fullUpload(a(), tenantA, "sized.pdf", blob);

    expect(completed.status).toBe("pending");
    expect(completed.size_bytes).toBe(blob.size);
    expect(completed.mime_type).toBe("application/pdf");

    const stored = await readRow(a(), row.id);
    expect(stored).toMatchObject({
      status: "pending",
      size_bytes: blob.size,
      mime_type: "application/pdf",
    });
    const downloaded = await a().client.storage.from(BUCKET).download(row.storage_path);
    expect(downloaded.data?.size).toBe(blob.size);
  });

  it("upload is refused when no matching row exists", async () => {
    const before = await listFiles(a(), tenantA);

    const { data, error } = await uploadTo(
      a(),
      `${tenantA}/${randomUUID()}`,
      pdfBlob("no row"),
    );
    expect(data).toBeNull();
    expect(error).not.toBeNull();

    expect(await listFiles(a(), tenantA)).toEqual(before);
  });

  it("upload is refused for a different member of the same tenant", async () => {
    // A creates the row in C; B, a member of C, may not upload to it.
    const row = await createRow(a(), tenantC, "a-in-c.pdf");
    const asB = await uploadTo(b(), row.storage_path, pdfBlob("from B"));
    expect(asB.data).toBeNull();
    expect(asB.error).not.toBeNull();
    expect(await listFiles(a(), tenantC)).toEqual([docDinC.id]);

    // control: the uploader can
    const asA = await uploadTo(a(), row.storage_path, pdfBlob("from A in C"));
    expect(asA.error).toBeNull();
    const done = await complete(a(), row.id);
    expect(done.error).toBeNull();
    docAinC = done.data as DocumentRow;
    expect(docAinC.status).toBe("pending");
  });

  it("re-upload and upsert to an existing path are refused", async () => {
    const again = await uploadTo(a(), objectPathA, pdfBlob("replacement"));
    expect(again.data).toBeNull();
    expect(again.error).not.toBeNull();

    const upsert = await a().client.storage
      .from(BUCKET)
      .upload(objectPathA, pdfBlob("overwrite"), { contentType: "application/pdf", upsert: true });
    expect(upsert.data).toBeNull();
    expect(upsert.error).not.toBeNull();

    const own = await a().client.storage.from(BUCKET).download(objectPathA);
    expect(await own.data?.text()).toBe(await secretA.text());
  });

  it("the bucket rejects a disallowed type", async () => {
    const row = await createRow(a(), tenantA, "notes.txt");
    const { data, error } = await uploadTo(
      a(),
      row.storage_path,
      new Blob(["plain text"], { type: "text/plain" }),
    );
    expect(data).toBeNull();
    expect(error?.message).toMatch(/mime type/i);

    // nothing stored, so the row can't be completed
    const done = await complete(a(), row.id);
    expect(done.error?.code).toBe("55000");
    expect((await readRow(a(), row.id))?.status).toBe("uploading");
  });

  it("the bucket rejects a file over 10 MB", async () => {
    const row = await createRow(a(), tenantA, "huge.pdf");
    const big = new Blob(["%PDF-1.4\n", new Uint8Array(MAX_FILE_BYTES - 8)], {
      type: "application/pdf",
    });
    expect(big.size).toBe(MAX_FILE_BYTES + 1);

    const { data, error } = await uploadTo(a(), row.storage_path, big);
    expect(data).toBeNull();
    expect(error?.message).toMatch(/size|large|exceed/i);

    const done = await complete(a(), row.id);
    expect(done.error?.code).toBe("55000");
    expect((await readRow(a(), row.id))?.status).toBe("uploading");
  });

  it("completing is refused for a non-uploader, a row not in 'uploading', and a missing object", async () => {
    // B's row in C with its file in place: only B may complete it.
    rowBWithFile = await createRow(b(), tenantC, "b-in-c.pdf");
    const upload = await uploadTo(b(), rowBWithFile.storage_path, pdfBlob("from B in C"));
    expect(upload.error).toBeNull();

    const asOwner = await complete(a(), rowBWithFile.id);
    expect(asOwner.data).toBeNull();
    expect(asOwner.error?.code).toBe("42501");
    expect((await readRow(a(), rowBWithFile.id))?.status).toBe("uploading");

    // already completed
    const twice = await complete(a(), documentA);
    expect(twice.error?.code).toBe("55000");
    expect((await readRow(a(), documentA))?.status).toBe("pending");

    // no object at the row's path
    rowBNoFile = await createRow(b(), tenantC, "b-never-uploaded.pdf");
    const missing = await complete(b(), rowBNoFile.id);
    expect(missing.error?.code).toBe("55000");
    expect((await readRow(b(), rowBNoFile.id))?.status).toBe("uploading");

    // an id that isn't anyone's row looks the same as someone else's
    const unknown = await complete(b(), randomUUID());
    expect(unknown.error?.code).toBe("42501");
  });
});

describe("storage under tenant A's prefix", () => {
  it("B cannot list or download tenant A's files", async () => {
    const listed = await b().client.storage.from(BUCKET).list(tenantA);
    expect(listed.data ?? []).toEqual([]);

    const downloaded = await b().client.storage.from(BUCKET).download(objectPathA);
    expect(downloaded.data).toBeNull();
    expect(downloaded.error).not.toBeNull();

    const signed = await b().client.storage.from(BUCKET).createSignedUrl(objectPathA, 60);
    expect(signed.data).toBeNull();
    expect(signed.error).not.toBeNull();

    // control
    const own = await a().client.storage.from(BUCKET).download(objectPathA);
    expect(await own.data?.text()).toBe(await secretA.text());
  });

  it("B cannot upload a new file under tenant A's prefix", async () => {
    const before = await listFiles(a(), tenantA);
    const { data, error } = await uploadTo(b(), `${tenantA}/${randomUUID()}`, pdfBlob("from B"));
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(await listFiles(a(), tenantA)).toEqual(before);
  });

  it("B cannot overwrite, move or delete tenant A's file", async () => {
    const overwrite = await b().client.storage
      .from(BUCKET)
      .upload(objectPathA, pdfBlob("overwritten by B"), {
        contentType: "application/pdf",
        upsert: true,
      });
    expect(overwrite.error).not.toBeNull();

    const move = await b().client.storage
      .from(BUCKET)
      .move(objectPathA, `${tenantB}/stolen-${runId}.pdf`);
    expect(move.error).not.toBeNull();

    // Storage reports success with nothing removed when RLS hides the object,
    // so the real assertion is that A's file is intact afterwards.
    const removed = await b().client.storage.from(BUCKET).remove([objectPathA]);
    expect(removed.data ?? []).toEqual([]);

    const own = await a().client.storage.from(BUCKET).download(objectPathA);
    expect(await own.data?.text()).toBe(await secretA.text());
  });
});

describe("renaming and deleting documents", () => {
  it("a member cannot rename someone else's document; the uploader and an owner can", async () => {
    // B is a plain member of C. docDinC was uploaded by D, another plain member.
    const asB = await b().client
      .from("documents")
      .update({ filename: "renamed-by-b.pdf" })
      .eq("id", docDinC.id)
      .select("id");
    expect(asB.error).toBeNull();
    expect(asB.data ?? []).toEqual([]);
    expect((await readRow(a(), docDinC.id))?.filename).toBe("d-in-c.pdf");

    // the uploader, who is not an admin
    const asD = await d().client
      .from("documents")
      .update({ filename: "renamed-by-d.pdf" })
      .eq("id", docDinC.id)
      .select("filename");
    expect(asD.error).toBeNull();
    expect(asD.data).toEqual([{ filename: "renamed-by-d.pdf" }]);

    // the owner, who did not upload it
    const asA = await a().client
      .from("documents")
      .update({ filename: "renamed-by-a.pdf" })
      .eq("id", docDinC.id)
      .select("filename");
    expect(asA.error).toBeNull();
    expect(asA.data).toEqual([{ filename: "renamed-by-a.pdf" }]);
  });

  it("a member cannot delete a file or a row", async () => {
    // B is a plain member of C. docAinC is A's completed document there.
    const removed = await b().client.storage.from(BUCKET).remove([docAinC.storage_path]);
    expect(removed.data ?? []).toEqual([]);

    const deleted = await b().client
      .from("documents")
      .delete()
      .eq("id", docAinC.id)
      .select("id");
    expect(deleted.data ?? []).toEqual([]);

    const file = await a().client.storage.from(BUCKET).download(docAinC.storage_path);
    expect(file.error).toBeNull();
    expect((await readRow(a(), docAinC.id))?.status).toBe("pending");
  });

  it("a row cannot be deleted while its file exists, even by an admin", async () => {
    // A owns C. The delete policy lets it through; the trigger refuses.
    const { data, error } = await a().client
      .from("documents")
      .delete()
      .eq("id", docAinC.id)
      .select("id");
    expect(data).toBeNull();
    expect(error?.code).toBe("55000");

    expect((await readRow(a(), docAinC.id))?.id).toBe(docAinC.id);
  });
});

describe("membership role escalation", () => {
  async function roleOfBInC() {
    const { data, error } = await a().client
      .from("memberships")
      .select("role")
      .eq("tenant_id", tenantC)
      .eq("user_id", b().id)
      .single();
    if (error) throw error;
    return data.role as string;
  }

  it("B cannot add themselves to tenant A", async () => {
    const { error } = await b().client
      .from("memberships")
      .insert({ tenant_id: tenantA, user_id: b().id, role: "owner" });
    expect(error?.code).toBe("42501");

    const own = await a().client
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenantA);
    expect(own.data).toEqual([{ user_id: a().id }]);
  });

  it("a member cannot raise their own role", async () => {
    expect(await roleOfBInC()).toBe("member");

    for (const role of ["admin", "owner"]) {
      const { data } = await b().client
        .from("memberships")
        .update({ role })
        .eq("tenant_id", tenantC)
        .eq("user_id", b().id)
        .select("id");
      expect(data ?? []).toEqual([]);
    }

    expect(await roleOfBInC()).toBe("member");
  });

  it("an admin cannot promote themselves to owner", async () => {
    const promoted = await a().client
      .from("memberships")
      .update({ role: "admin" })
      .eq("tenant_id", tenantC)
      .eq("user_id", b().id)
      .select("id");
    expect(promoted.error).toBeNull();
    expect(await roleOfBInC()).toBe("admin");

    const { data } = await b().client
      .from("memberships")
      .update({ role: "owner" })
      .eq("tenant_id", tenantC)
      .eq("user_id", b().id)
      .select("id");
    expect(data ?? []).toEqual([]);

    expect(await roleOfBInC()).toBe("admin");
  });

  it("an admin cannot demote or remove the owner", async () => {
    const demote = await b().client
      .from("memberships")
      .update({ role: "member" })
      .eq("tenant_id", tenantC)
      .eq("user_id", a().id)
      .select("id");
    expect(demote.data ?? []).toEqual([]);

    const remove = await b().client
      .from("memberships")
      .delete()
      .eq("tenant_id", tenantC)
      .eq("user_id", a().id)
      .select("id");
    expect(remove.data ?? []).toEqual([]);

    const owner = await a().client
      .from("memberships")
      .select("role")
      .eq("tenant_id", tenantC)
      .eq("user_id", a().id)
      .single();
    expect(owner.data?.role).toBe("owner");
  });

  it("the last owner cannot remove or demote themselves", async () => {
    // A is tenant A's only owner. Self-demotion is refused by the update
    // policy (zero rows); self-removal passes the delete policy and is
    // refused by the memberships_keep_an_owner trigger.
    const demote = await a().client
      .from("memberships")
      .update({ role: "admin" })
      .eq("tenant_id", tenantA)
      .eq("user_id", a().id)
      .select("id");
    expect(demote.data ?? []).toEqual([]);

    const remove = await a().client
      .from("memberships")
      .delete()
      .eq("tenant_id", tenantA)
      .eq("user_id", a().id)
      .select("id");
    expect(remove.data).toBeNull();
    expect(remove.error?.code).toBe("23514");

    const own = await a().client
      .from("memberships")
      .select("user_id, role")
      .eq("tenant_id", tenantA);
    expect(own.data).toEqual([{ user_id: a().id, role: "owner" }]);
  });

  it("an admin cannot grant the owner role by inserting a membership", async () => {
    // B is an admin of C and already has a row there. Postgres checks the RLS
    // with-check clause before unique indexes, so a 42501 here means the
    // policy refused it, not the (tenant_id, user_id) unique constraint.
    const { error } = await b().client
      .from("memberships")
      .insert({ tenant_id: tenantC, user_id: b().id, role: "owner" });
    expect(error?.code).toBe("42501");
  });
});

describe("admin deletion and removed members", () => {
  it("an admin can rename someone else's document", async () => {
    // B is now an admin of C; docAinC was uploaded by A.
    const { data, error } = await b().client
      .from("documents")
      .update({ filename: "renamed-by-admin.pdf" })
      .eq("id", docAinC.id)
      .select("filename");
    expect(error).toBeNull();
    expect(data).toEqual([{ filename: "renamed-by-admin.pdf" }]);
  });

  it("an admin can delete a file, then its row", async () => {
    // B is now an admin of C. The file must go first.
    const removed = await b().client.storage.from(BUCKET).remove([docAinC.storage_path]);
    expect(removed.error).toBeNull();
    expect((removed.data ?? []).map((f) => f.name)).toEqual([docAinC.storage_path]);

    const deleted = await b().client
      .from("documents")
      .delete()
      .eq("id", docAinC.id)
      .select("id");
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id: docAinC.id }]);

    expect(await readRow(a(), docAinC.id)).toBeNull();
    expect(await listFiles(a(), tenantC)).not.toContain(docAinC.id);
    const signed = await a().client.storage.from(BUCKET).createSignedUrl(docAinC.storage_path, 60);
    expect(signed.data).toBeNull();
    expect(signed.error).not.toBeNull();
    // Deliberately not asserted through download(): Supabase's CDN can keep
    // serving a deleted object to the session that fetched it earlier for a
    // short while (observed up to 30 s with cacheControl 0). The object index
    // (list and signed URL creation above) is the source of truth. See
    // SECURITY.md, "Deleted files and the CDN cache".
  });

  it("a removed member cannot upload to or complete their old rows", async () => {
    const removed = await a().client
      .from("memberships")
      .delete()
      .eq("tenant_id", tenantC)
      .eq("user_id", b().id)
      .select("id");
    expect(removed.error).toBeNull();
    expect(removed.data).toHaveLength(1);

    // B's row with no file: the upload is refused although B created it
    const upload = await uploadTo(b(), rowBNoFile.storage_path, pdfBlob("after removal"));
    expect(upload.data).toBeNull();
    expect(upload.error).not.toBeNull();

    // B's row whose file is already there: completion is refused
    const done = await complete(b(), rowBWithFile.id);
    expect(done.data).toBeNull();
    expect(done.error?.code).toBe("42501");

    // and B can no longer see C's files or rows
    expect((await b().client.storage.from(BUCKET).list(tenantC)).data ?? []).toEqual([]);
    expect((await b().client.from("documents").select("id").eq("tenant_id", tenantC)).data).toEqual([]);

    // control: the rows still exist for the owner, untouched
    expect((await readRow(a(), rowBNoFile.id))?.status).toBe("uploading");
    expect((await readRow(a(), rowBWithFile.id))?.status).toBe("uploading");
    expect(await listFiles(a(), tenantC)).toEqual([rowBWithFile.id, docDinC.id].sort());
  });
});

describe("uploader account deletion", () => {
  it("a document outlives its uploader's account, with uploaded_by set to null", async () => {
    expect((await readRow(a(), docDinC.id))?.uploaded_by).toBe(d().id);

    // D owns no tenant, so this is allowed. Their membership in C cascades.
    const { error } = await d().client.rpc("delete_own_account");
    expect(error).toBeNull();
    userDDeleted = true;

    const members = await a().client
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenantC)
      .eq("user_id", d().id);
    expect(members.data).toEqual([]);

    // the owner still sees the document and can still fetch its file
    const row = await readRow(a(), docDinC.id);
    expect(row).toMatchObject({ id: docDinC.id, status: "pending", uploaded_by: null });
    const file = await a().client.storage.from(BUCKET).download(docDinC.storage_path);
    expect(file.error).toBeNull();
    expect(file.data?.size).toBe(docDinC.size_bytes);
  });
});

describe("self-service deletion guards", () => {
  it("delete_tenant refuses while a file remains", async () => {
    const { error } = await a().client.rpc("delete_tenant", { p_tenant_id: tenantA });
    expect(error?.code).toBe("55000");

    const own = await a().client.from("tenants").select("id").eq("id", tenantA);
    expect(own.data).toEqual([{ id: tenantA }]);
  });

  it("delete_own_account refuses while the caller owns a tenant", async () => {
    const { error } = await a().client.rpc("delete_own_account");
    expect(error?.code).toBe("55000");

    const stillThere = await a().client.from("tenants").select("id").eq("id", tenantA);
    expect(stillThere.data).toEqual([{ id: tenantA }]);
  });
});

describe("auth configuration", () => {
  it("Supabase itself rejects a password shorter than 15 characters", async () => {
    // The form enforces the minimum too, so this calls signUp directly.
    const client = newClient();
    const password = "abcdefghijklm1"; // 14 characters
    expect(password).toHaveLength(MIN_PASSWORD_LENGTH - 1);
    const { data, error } = await client.auth.signUp({
      email: `tenant-isolation-short-${runId}@${emailDomain}`,
      password,
    });

    // If the dashboard setting isn't saved, the user gets created; remove
    // it so a failing run leaves nothing behind.
    if (data.user) {
      const cleanup = await client.rpc("delete_own_account");
      throw new Error(
        `a 14 character password was accepted (user ${data.user.id}; cleanup ${cleanup.error ? "failed: " + cleanup.error.message : "ok"}). The minimum password length isn't saved in the dashboard.`,
      );
    }
    expect(error?.code).toBe("weak_password");
    expect(error?.message).toMatch(/15/);
  });
});

describe("anonymous access", () => {
  const anon = newClient();

  it("cannot read any table", async () => {
    for (const table of ["tenants", "memberships", "documents"]) {
      const { data, error } = await anon.from(table).select("id").limit(1);
      expect(data, table).toBeNull();
      expect(error?.code, table).toBe("42501");
    }
  });

  it("cannot call any RPC", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["create_tenant", { p_name: "anon", p_slug: `anon-${runId}` }],
      ["delete_tenant", { p_tenant_id: tenantA }],
      ["delete_own_account", {}],
      ["complete_document_upload", { p_document_id: documentA }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await anon.rpc(fn, args);
      expect(error?.code, fn).toBe("42501");
    }

    const own = await a().client.from("tenants").select("id").eq("id", tenantA);
    expect(own.data).toEqual([{ id: tenantA }]);
  });

  it("cannot list or download from storage", async () => {
    const listed = await anon.storage.from(BUCKET).list(tenantA);
    expect(listed.data ?? []).toEqual([]);

    const downloaded = await anon.storage.from(BUCKET).download(objectPathA);
    expect(downloaded.data).toBeNull();
    expect(downloaded.error).not.toBeNull();

    const signed = await anon.storage.from(BUCKET).createSignedUrl(objectPathA, 60);
    expect(signed.data).toBeNull();
    expect(signed.error).not.toBeNull();

    const own = await a().client.storage.from(BUCKET).download(objectPathA);
    expect(await own.data?.text()).toBe(await secretA.text());
  });
});
