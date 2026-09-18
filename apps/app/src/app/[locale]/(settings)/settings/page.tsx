"use client";

import { clearDisplayCaches } from "@/lib/display-cache";
import { useScopedI18n } from "@/locales/client";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import { Input } from "@v1/ui/input";
import { UploadInput } from "@v1/ui/upload-input";
import { useDoubleCheck } from "@v1/ui/utils";
import type { UploadFileResponse } from "@v1/ui/upload-input";
import { useAction, useMutation, useQuery } from "convex/react";
import { Camera } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// Client mirror of convex/utils/validators.ts `username` — an instant, clear
// message before the server round-trip. The mutation still validates server-side.
function usernameError(name: string): string | null {
  if (name.length < 3) return "Username must be at least 3 characters.";
  if (name.length > 32) return "Username must be 32 characters or fewer.";
  if (!/^[a-zA-Z0-9]+$/.test(name))
    return "Username may only contain alphanumeric characters.";
  return null;
}

/**
 * Change password — the self-service credential rotation this app lacked.
 *
 * Without it the ONLY way to change a password was the emailed reset code, and
 * on a deployment whose mail transport refuses local catchers an address that
 * cannot receive mail could never rotate its credential at all. The server
 * action enforces the same policy as sign-up/reset, verifies the current
 * password, and revokes every other session plus its refresh tokens.
 */
function ChangePasswordSection() {
  const changePassword = useAction(api.authPassword.changePassword);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length > 0 && !mismatch && !busy;

  const onSubmit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Other sessions were signed out.");
    } catch (e) {
      const msg =
        (e as { data?: string })?.data ??
        (e as Error)?.message ??
        "Could not change the password.";
      toast.error(String(msg).replace(/^Uncaught ConvexError:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex flex-col gap-2 p-6">
        <h2 className="text-lg font-medium text-primary">Change password</h2>
        <p className="text-sm font-normal text-primary/60">
          Changing your password signs out every other device.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:max-w-md">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            aria-label="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            aria-label="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            aria-label="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && (
            <p className="text-sm text-destructive">
              The two new passwords do not match.
            </p>
          )}
        </div>
      </div>
      <div className="flex min-h-14 items-center justify-end rounded-b-2xl border-t border-border bg-card px-6 py-3">
        <Button type="button" size="sm" disabled={!ready} onClick={onSubmit}>
          {busy ? "Changing…" : "Change password"}
        </Button>
      </div>
    </div>
  );
}

export default function ProfileSection() {
  const t = useScopedI18n("settings");
  const user = useQuery(api.users.getUser);
  const { signOut } = useAuthActions();
  const updateUserImage = useMutation(api.users.updateUserImage);
  const updateUsername = useMutation(api.users.updateUsername);
  const updateName = useMutation(api.users.updateName);
  const removeUserImage = useMutation(api.users.removeUserImage);
  const generateUploadUrl = useMutation(api.users.generateUploadUrl);
  const deleteCurrentUserAccount = useAction(api.users.deleteCurrentUserAccount);
  const requestDeletionCode = useAction(api.users.requestAccountDeletionCode);
  // Which factor this account can actually re-authenticate with. A Google-only
  // user has no password to re-enter, so they confirm by email instead.
  const deletionFactor = useQuery(api.users.deletionFactor);
  const { doubleCheck, getButtonProps } = useDoubleCheck();

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteSecret, setDeleteSecret] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [codeSent, setCodeSent] = useState(false);

  // getUser resolves async; seed the fields once it arrives.
  useEffect(() => {
    if (user && !hydrated) {
      setDisplayName(user.displayName ?? "");
      setUsername(user.username ?? "");
      setHydrated(true);
    }
  }, [user, hydrated]);

  // The account rail paints from a localStorage copy until the live query
  // lands (~2-3s cold), and that copy holds the OLD avatarUrl — so without
  // this the previous photo comes back on the next load and looks like the
  // change was lost. Same reason the profile save clears it.
  const handleUpdateUserImage = async (uploaded: UploadFileResponse[]) => {
    await updateUserImage({
      imageId: (uploaded[0]?.response as { storageId: Id<"_storage"> })
        .storageId,
    });
    clearDisplayCaches();
  };

  const handleRemoveUserImage = async () => {
    await removeUserImage({});
    clearDisplayCaches();
  };

  const needsCode = deletionFactor?.needs === "code";

  const handleSendDeletionCode = async () => {
    try {
      await requestDeletionCode();
      setCodeSent(true);
      toast.success("We emailed you a confirmation code.");
    } catch {
      toast.error("Couldn't send the code. Try again.");
    }
  };

  // The password/code is verified SERVER-SIDE in deleteCurrentUserAccount. The
  // double-check button and this field are convenience, not the control: the
  // action refuses outright when the factor is missing or wrong.
  const handleDeleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteCurrentUserAccount(
        needsCode ? { code: deleteSecret } : { password: deleteSecret },
      );
      clearDisplayCaches();
      signOut();
    } catch (err) {
      const data = (err as { data?: unknown })?.data;
      toast.error(
        typeof data === "string" ? data : "Couldn't delete your account.",
      );
    } finally {
      setDeleting(false);
    }
  };

  // TRIMMED ON BOTH SIDES, deliberately. `dirty` used to compare the raw field
  // while onSave compared `.trim()`, so typing a trailing space over an
  // unchanged name enabled Save, sent NOTHING, and still toasted "Profile
  // updated" — the reported "Save sometimes does nothing". Worse, because the
  // stored value never changed, the field stayed dirty and the button stayed
  // enabled forever. One definition of "changed" removes both.
  const nextName = displayName.trim();
  const nextUsername = username.trim();
  const dirty =
    !!user &&
    (nextName !== (user.displayName ?? "") ||
      nextUsername !== (user.username ?? ""));

  const reset = () => {
    if (!user) return;
    setDisplayName(user.displayName ?? "");
    setUsername(user.username ?? "");
  };

  const onSave = async () => {
    if (!user || saving) return;
    if (nextUsername !== (user.username ?? "")) {
      const err = usernameError(nextUsername);
      if (err) {
        toast.error(err);
        return;
      }
    }
    setSaving(true);
    try {
      if (nextName !== (user.displayName ?? ""))
        await updateName({ name: nextName });
      if (nextUsername !== (user.username ?? ""))
        await updateUsername({ username: nextUsername });
      // Show the fields exactly as they were SENT. Otherwise a value that only
      // differed by whitespace stays in the inputs, and the form reads as
      // unsaved against a row that is now correct.
      setDisplayName(nextName);
      setUsername(nextUsername);
      clearDisplayCaches();
      toast.success("Profile updated");
    } catch (e) {
      // A ConvexError arrives with the operator-facing prefix and a stack
      // attached: "Uncaught ConvexError: <msg>\n  at handler (../convex/...)".
      // Rendering that raw shows the user internal file paths and line numbers.
      // `.data` carries the clean message; every other surface in this app
      // (change-password above, projects, chat send) already strips the prefix.
      const msg =
        (e as { data?: string })?.data ??
        (e as Error)?.message ??
        "Couldn't save your profile";
      toast.error(
        String(msg)
          .replace(/^Uncaught ConvexError:\s*/, "")
          .split("\n")[0],
      );
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  const initial = (displayName || username || user.email || "?")
    .charAt(0)
    .toUpperCase();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          Profile
        </h1>
        <p className="mt-1 text-sm text-primary/65">
          Your public identity across the workspace.
        </p>
      </div>

      {/* Edit profile */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-col items-center gap-3">
          <label
            htmlFor="avatar_field"
            className="group relative flex cursor-pointer overflow-hidden rounded-full transition active:scale-95"
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                className="h-24 w-24 rounded-full object-cover ring-2 ring-brand/30"
                alt={username || user.email || "Avatar"}
              />
            ) : (
              <div className="grid h-24 w-24 place-items-center rounded-full bg-foreground text-2xl font-semibold text-background">
                {initial}
              </div>
            )}
            <div className="absolute inset-0 z-10 hidden items-center justify-center bg-black/45 group-hover:flex">
              <Camera className="h-6 w-6 text-white" />
            </div>
          </label>
          <UploadInput
            id="avatar_field"
            type="file"
            accept="image/*"
            className="peer sr-only"
            required
            tabIndex={-1}
            generateUploadUrl={generateUploadUrl}
            onUploadComplete={handleUpdateUserImage}
          />
          {user.avatarUrl && (
            <button
              type="button"
              onClick={() => void handleRemoveUserImage()}
              className="text-xs text-primary/65 underline-offset-2 transition hover:text-primary/80 hover:underline"
            >
              {t("avatar.resetButton")}
            </button>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="display_name"
              className="text-sm font-medium text-primary/80"
            >
              Display name
            </label>
            <Input
              id="display_name"
              value={displayName}
              maxLength={50}
              placeholder="Your name"
              autoComplete="off"
              onChange={(e) => setDisplayName(e.target.value)}
              className="bg-transparent"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="username"
              className="text-sm font-medium text-primary/80"
            >
              Username
            </label>
            <Input
              id="username"
              value={username}
              placeholder="username"
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
              className="bg-transparent"
            />
            <p className="text-xs text-primary/60">
              3–32 characters, letters and numbers only.
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!dirty || saving}
            onClick={reset}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <ChangePasswordSection />

      {/* Delete account */}
      <div className="rounded-2xl border border-destructive/60 bg-card">
        <div className="flex flex-col gap-2 p-6">
          <h2 className="text-lg font-medium text-primary">
            {t("deleteAccount.title")}
          </h2>
          <p className="text-sm font-normal text-primary/60">
            {t("deleteAccount.description")}
          </p>
        </div>
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-destructive/30 bg-muted px-6 py-3">
          <p className="text-sm font-normal text-primary/60">
            {t("deleteAccount.warning")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {needsCode && !codeSent ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleSendDeletionCode}
              >
                Email me a code
              </Button>
            ) : (
              <Input
                type={needsCode ? "text" : "password"}
                value={deleteSecret}
                autoComplete={needsCode ? "one-time-code" : "current-password"}
                inputMode={needsCode ? "numeric" : undefined}
                placeholder={needsCode ? "Emailed code" : "Your password"}
                onChange={(e) => setDeleteSecret(e.target.value)}
                className="h-9 w-44 bg-transparent"
              />
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={deleting || !deleteSecret}
              {...getButtonProps({
                onClick: doubleCheck ? handleDeleteAccount : undefined,
              })}
            >
              {doubleCheck
                ? t("deleteAccount.confirmButton")
                : t("deleteAccount.deleteButton")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
