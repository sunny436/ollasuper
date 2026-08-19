// Verifies the chat highlighter resolves + loads every requested language and
// returns highlighted nodes (not the plain-<pre> null fallback). Runs in bun,
// which imports the TS module directly; shiki loads its bundled grammars from
// node_modules. No network, no browser.
//
//   cd e2e && bun run md-highlight.mjs
const mod = await import(
  "../apps/app/src/app/[locale]/(workspace)/chat/_lib/highlighter.ts"
);
const { highlight } = mod;

// (fence-language-as-written, a tiny sample) for every required language.
const CASES = [
  ["c", "int main(void){return 0;}"],
  ["cpp", "#include <vector>\nint x=1;"],
  ["c++", "auto x = 1;"],
  ["csharp", "class A { void M(){} }"],
  ["c#", "int x = 1;"],
  ["java", "class A { int x; }"],
  ["swift", "let x = 1"],
  ["kotlin", "val x = 1"],
  ["php", "<?php echo 1; ?>"],
  ["ruby", "def a; end"],
  ["r", "x <- c(1,2)"],
  ["dart", "void main(){}"],
  ["lua", "local x = 1"],
  ["perl", "my $x = 1;"],
  ["assembly", "mov eax, 1"],
  ["matlab", "x = [1 2 3];"],
  ["scss", "$c: red; a{color:$c}"],
  ["svg", "<svg><rect/></svg>"],
  ["xml", "<a><b/></a>"],
  ["mysql", "SELECT 1;"],
  ["graphql", "type Q { a: Int }"],
  ["powershell", "$x = 1"],
  ["batch", "@echo off"],
  ["toml", "a = 1"],
  ["csv", "a,b\n1,2"],
  ["tsv", "a\tb\n1\t2"],
  ["dockerfile", "FROM node:20"],
  ["ini", "[s]\na=1"],
  ["env", "A=1"],
  ["nginx", "server { listen 80; }"],
  ["makefile", "all:\n\techo hi"],
  ["gitignore", "node_modules/"],
  ["diff", "- a\n+ b"],
  ["patch", "--- a\n+++ b"],
];

let pass = 0;
const fail = [];
for (const [lang, code] of CASES) {
  try {
    const nodes = await highlight(code, lang);
    if (nodes) pass++;
    else fail.push(lang);
  } catch (e) {
    fail.push(`${lang} (threw: ${e.message})`);
  }
}

// Unknown language must degrade to the plain <pre> (null), never throw.
const unknown = await highlight("noop", "totally-not-a-language-xyz");
const unknownOk = unknown === null;

console.log(`languages highlighted: ${pass}/${CASES.length}`);
if (fail.length) console.log("  FAILED:", fail.join(", "));
console.log(`unknown-language → plain <pre> (null): ${unknownOk ? "OK" : "FAIL"}`);

if (fail.length || !unknownOk) process.exit(1);
console.log("HIGHLIGHT OK");
