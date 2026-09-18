// The words the organization page uses for roles and states. Database
// values (roles, status enums) never reach the screen as they are.

import type { Role } from "./types";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function roleAbilities(role: Role): string {
  return role === "member"
    ? "You can upload and download documents. Admins run extraction and delete documents."
    : "You can upload, extract and delete documents.";
}

export function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}

const STATUS_LABELS: Record<string, string> = {
  uploading: "Upload incomplete",
  pending: "Ready to extract",
  processing: "Extracting",
  extracted: "Extracted",
  needs_review: "Needs review",
  failed: "Extraction failed",
};

// A status the page doesn't know yet still reads as words, not as an enum.
export function statusLabel(status: string): string {
  const known = STATUS_LABELS[status];
  if (known) return known;
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The Documents heading takes focus after a delete removes the item that
// had it, so keyboard users don't land at the top of the page.
export const DOCUMENTS_HEADING_ID = "documents-heading";
