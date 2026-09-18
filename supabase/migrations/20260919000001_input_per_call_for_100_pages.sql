-- Raise the abandoned-run estimate's per-call input cap from 200 000 to
-- 304 500 tokens: the prompt (4 500) plus the most pages a document may have
-- (100) at 3 000 each.
--
-- 200 000 was Claude Haiku 4.5's context window. Claude Sonnet 5, the
-- default since 20260918000004, has a 1M context and read about 2 000 tokens
-- per sparse page, so a 100-page PDF can send about 205 000 tokens a call,
-- more for dense pages. Above about 65 pages the estimate could fall short
-- of what a real run spends. At 304 500 the estimate's own per-page figure
-- decides, up to the 100-page limit documents are held to (SECURITY.md,
-- "Stale runs").
--
-- The per-run clamp (max_input_tokens_per_run, 800 000) still applies, and
-- binds from 88 pages: a run of 88 to 100 pages, or of unknown length, is
-- charged 800 000 in and 6 144 out, 1.66144 USD at Sonnet 5 prices (it was
-- 1.26144). Up to 87 pages the charge grows with every page; one page is
-- unchanged at 0.10644 USD.
--
-- Only data changes. The mirror in src/lib/extraction/config.ts
-- (maxInputTokensPerCall) changes with it, and tests/extraction.test.ts
-- checks the two agree.

update public.extraction_limits
set max_input_tokens_per_call = 304500;

alter table public.extraction_limits
  alter column max_input_tokens_per_call set default 304500;
