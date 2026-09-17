// Proves RLS keeps tenants apart, using only the publishable key and real
// signed-in sessions (never the service role), against the project in
// .env.test. It creates its own users, tenants, rows and files and removes
// them in afterAll via delete_tenant and delete_own_account.
//
// Every "cannot" assertion is paired with a check that the owner can still
// see the original data, so a test can't pass just because the setup failed
// or the data was never there.

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
const runId = randomUUID().slice(0, 8);

type TestUser = { client: SupabaseClient; id: string; email: string };

function newClient() {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signUpUser(label: string): Promise<TestUser> {
  const client = newClient();
  const email = `tenant-isolation-${label}-${runId}@${emailDomain}`;
  const { data, error } = await client.auth.signUp({
    email,
    password: `${randomUUID()}Aa1!`,
  });
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

// Set in beforeAll; cleanup handles whatever got created before a failure.
let userA: TestUser | undefined;
let userB: TestUser | undefined;
const ownedTenants: { owner: () => TestUser | undefined; id: string }[] = [];

let tenantA: string; // A owns it; B has no access
let tenantB: string; // B owns it
let tenantC: string; // A owns it; B joins as member, later admin
let documentA: string;
let objectPathA: string;

// Non-null accessors so tests fail loudly if setup didn't finish.
const a = () => userA!;
const b = () => userB!;

beforeAll(async () => {
  userA = await signUpUser("a");
  userB = await signUpUser("b");

  tenantA = await createTenant(a(), "a");
  ownedTenants.push({ owner: () => userA, id: tenantA });
  tenantB = await createTenant(b(), "b");
  ownedTenants.push({ owner: () => userB, id: tenantB });
  tenantC = await createTenant(a(), "c");
  ownedTenants.push({ owner: () => userA, id: tenantC });

  objectPathA = `${tenantA}/${runId}.txt`;
  const upload = await a().client.storage
    .from(BUCKET)
    .upload(objectPathA, new Blob(["tenant A secret"], { type: "text/plain" }), {
      contentType: "text/plain",
    });
  if (upload.error) throw new Error(`A's upload failed: ${upload.error.message}`);

  const doc = await a().client
    .from("documents")
    .insert({
      tenant_id: tenantA,
      storage_path: objectPathA,
      filename: "secret.txt",
      mime_type: "text/plain",
      size_bytes: 15,
    })
    .select("id")
    .single();
  if (doc.error) throw new Error(`A's document insert failed: ${doc.error.message}`);
  documentA = doc.data.id;

  const join = await a().client
    .from("memberships")
    .insert({ tenant_id: tenantC, user_id: b().id, role: "member" });
  if (join.error) throw new Error(`adding B to tenant C failed: ${join.error.message}`);
});

afterAll(async () => {
  const problems: string[] = [];

  // Storage objects first: delete_tenant refuses while files remain, and SQL
  // can't delete them.
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

  for (const user of [userA, userB]) {
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
      .insert({
        tenant_id: tenantA,
        storage_path: `${tenantA}/injected-${runId}.txt`,
        filename: "injected.txt",
        mime_type: "text/plain",
        size_bytes: 1,
      })
      .select("id");

    expect(data).toBeNull();
    expect(error?.code).toBe("42501");

    const own = await a().client.from("documents").select("id").eq("tenant_id", tenantA);
    expect(own.data).toEqual([{ id: documentA }]);
  });

  it("B cannot update or delete tenant A's document", async () => {
    const updated = await b().client
      .from("documents")
      .update({ filename: "pwned.txt" })
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
    expect(own.data).toEqual({ filename: "secret.txt" });
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
    expect(await own.data?.text()).toBe("tenant A secret");
  });

  it("B cannot upload a new file under tenant A's prefix", async () => {
    const path = `${tenantA}/b-upload-${runId}.txt`;
    const { data, error } = await b().client.storage
      .from(BUCKET)
      .upload(path, new Blob(["from B"], { type: "text/plain" }));
    expect(data).toBeNull();
    expect(error).not.toBeNull();

    const own = await a().client.storage.from(BUCKET).list(tenantA);
    expect((own.data ?? []).map((f) => f.name)).toEqual([`${runId}.txt`]);
  });

  it("B cannot overwrite, move or delete tenant A's file", async () => {
    const overwrite = await b().client.storage
      .from(BUCKET)
      .upload(objectPathA, new Blob(["overwritten by B"], { type: "text/plain" }), {
        upsert: true,
      });
    expect(overwrite.error).not.toBeNull();

    const move = await b().client.storage
      .from(BUCKET)
      .move(objectPathA, `${tenantB}/stolen-${runId}.txt`);
    expect(move.error).not.toBeNull();

    // Storage reports success with nothing removed when RLS hides the object,
    // so the real assertion is that A's file is intact afterwards.
    const removed = await b().client.storage.from(BUCKET).remove([objectPathA]);
    expect(removed.data ?? []).toEqual([]);

    const own = await a().client.storage.from(BUCKET).download(objectPathA);
    expect(await own.data?.text()).toBe("tenant A secret");
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
