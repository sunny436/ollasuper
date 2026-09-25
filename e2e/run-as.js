// Run any suite as the account in a creds file, without the password ever
// reaching a shell, its history, a process list or this repo.
//
//   node run-as.js <credsFile> <script.js> [args...]
//
// <credsFile> is the 0600 JSON `{email, password}` that qa-throwaway.js writes.
// The durable QA account lives on the VM (/root/qa-account.json, 0600) — copy it
// to a local 0600 file for the run and delete it afterwards:
//
//   ssh root@172.16.70.25 cat /root/qa-account.json > "$TMP/qa.json"
//   node run-as.js "$TMP/qa.json" qa-responsive.js --part a11y
//
// It sets BOTH conventions the suites use: QA_EMAIL/QA_PASSWORD (most suites)
// and ADMIN_EMAIL/ADMIN_PASSWORD (the older ones, which mean "the account to
// sign in as", not an administrator). Nothing is printed.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [FILE, SCRIPT, ...rest] = process.argv.slice(2);
if (!FILE || !SCRIPT) {
  console.error("usage: node run-as.js <credsFile> <script.js> [args...]");
  process.exit(2);
}
const { email, password } = JSON.parse(fs.readFileSync(FILE, "utf8"));
if (!email || !password) {
  console.error(`${FILE} has no email/password`);
  process.exit(2);
}
const child = spawn(process.execPath, [path.resolve(__dirname, SCRIPT), ...rest], {
  stdio: "inherit",
  cwd: __dirname,
  env: {
    ...process.env,
    QA_EMAIL: email,
    QA_PASSWORD: password,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
  },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
