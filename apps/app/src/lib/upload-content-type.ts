/**
 * Re-export of the canonical rule, which lives in @v1/ui because the upload
 * component there performs the POST that actually sets a blob's stored type.
 *
 * One implementation on purpose: a second copy of a security rule is a second
 * thing to forget to update. The four app-side uploaders and the shared
 * UploadInput must neuter identically, and the backend guard
 * (convex/blobSafety.ts) remains the real boundary either way.
 */
export { storageContentType } from "@v1/ui/upload-content-type";
