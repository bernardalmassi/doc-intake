This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Uploads

Uploads are row first. A Server Action creates the `documents` row (only `tenant_id` and `filename`; the database sets everything else, including `storage_path = <tenant_id>/<id>`), the browser uploads the file straight to Supabase Storage at that path with the user's session, and `complete_document_upload` confirms the object and records its real size and type. Downloads are 60 second signed URLs created on click. Admins delete the file, then the row. The bucket accepts PDF, PNG and JPEG up to 10 MB. See `SECURITY.md` for what each layer enforces.

## Tenant isolation test

`tests/tenant-isolation.test.ts` checks that row-level security keeps tenants apart and that the upload flow can't be bypassed. It signs up three throwaway users once per run (an owner, a second user who is a member and later an admin of a shared tenant, and a member who deletes their own account mid-run), and asserts what each can and can't do to rows, files and memberships. It uses only the publishable key and real signed-in sessions, never the service role.

It runs against a real Supabase project, so:

1. The project needs every migration in `supabase/migrations/` applied (`npx supabase db push`). Cleanup uses `delete_tenant` and `delete_own_account` from `20260917000005_self_service_deletion.sql`.
2. Email confirmation must be off (Authentication → Sign In / Providers → Email → Confirm email), since the test needs a session straight from sign-up.
3. The minimum password length in the dashboard is 15; test passwords are 40 characters (Supabase caps them at 72).
4. Copy `.env.test.example` to `.env.test` and fill in the project URL and publishable key.

Then run:

```bash
npm test
```

The test deletes the users, tenants, rows and files it created, and fails if any cleanup step doesn't succeed. Each run makes three sign-ups plus one rejected sign-up attempt, which count toward the project's auth rate limit, so running it many times in a row may be throttled. The 39 tests take about 25 seconds.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
