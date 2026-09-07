// Test credentials come from the environment — never from a file in the repo.
//
// Every script here used to carry `process.env.ADMIN_PASSWORD || "<literal>"`.
// That fallback put the LIVE production admin password into 85 committed files
// and 49 commits of history, so read access to the repository WAS production
// admin access to app.ollasuper.com. The fallback is also the reason it
// survived: with a working default nobody ever had to set the variable, so
// nobody ever noticed the literal was there.
//
// So this fails loudly rather than defaulting. A missing variable stops the run
// with an instruction, which is recoverable in seconds; a silent default is the
// failure mode that hid a production credential in source control.
//
// NOTE: removing the literal does NOT un-leak it — it remains in git history.
// Rotating the account password is the part that actually closes this.
function adminPassword() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    throw new Error(
      "ADMIN_PASSWORD is not set. These scripts sign in to a real deployment, " +
        "so the password is supplied by the environment, not by the repo:\n" +
        '  PowerShell:  $env:ADMIN_PASSWORD = "..."\n' +
        '  bash:        export ADMIN_PASSWORD="..."',
    );
  }
  return pw;
}

/** Not a secret — the account name is public and stays defaulted. */
function adminEmail() {
  return process.env.ADMIN_EMAIL || "admin@myos.test";
}

module.exports = { adminPassword, adminEmail };
