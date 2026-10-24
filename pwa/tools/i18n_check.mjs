// Lists the words a person reads that do not go through the translation functions, and misuses of
// them (tools/i18n_scan.mjs). test/unit/i18n_coverage.test.mjs runs the same check on every file.
//
//   node tools/i18n_check.mjs                      every guarded file (app.js, lib/, screens/)
//   node tools/i18n_check.mjs src/screens/home.js  some files (or folders)
//   node tools/i18n_check.mjs --ignored            also print what i18n-ignore pragmas leave out
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from './i18n_scan.mjs';
import { sourceFiles, relSrc, SRC } from './i18n_extract.mjs';

// Files the check leaves out, each with the reason. Everything else in app.js, lib/ and screens/ is checked.
export const EXEMPT = Object.freeze({
  // Inlined into the loader (tools/loader_source.mjs): they cannot import lib/i18n.js, and their bytes
  // name the loader. Their sentences are shown through lib/loader_words.js (its test lists them).
  'lib/release.js': 'inlined into the loader; shown through lib/loader_words.js',
  'lib/update_sources.js': 'inlined into the loader; shown through lib/loader_words.js',
  'lib/server_address.js': 'inlined into the loader; shown through lib/loader_words.js',
  'lib/evm_server_address.js': 'inlined into the loader; shown through lib/loader_words.js',
  'lib/evm_server_check.js': "inlined into the loader; its English is a check's detail for whoever debugs a server, never shown as the reason",
  'lib/qr_worker.js': 'a worker: decodes QR codes, shows nothing',
});

export const guarded = (rel) => (rel === 'app.js' || rel.startsWith('lib/') || rel.startsWith('screens/')) && !EXEMPT[rel];

/** { texts, problems, ignored } for the given absolute file paths (guarded ones only). */
export function checkFiles(files) {
  const texts = [];
  const problems = [];
  const ignored = [];
  for (const f of files) {
    const rel = relSrc(f);
    if (!guarded(rel)) continue;
    let r;
    try {
      r = scanSource(readFileSync(f, 'utf8'), rel);
    } catch (e) {
      problems.push({ file: rel, line: 0, problem: `could not be read: ${e.message}` });
      continue;
    }
    for (const it of r.items) {
      if (it.kind === 'text') texts.push({ file: rel, line: it.line, value: it.value, reason: it.reason, call: it.call, at: it.at });
      if (it.kind === 'ignored') ignored.push({ file: rel, line: it.line, value: it.value, reason: it.reason });
    }
    for (const p of r.problems) problems.push({ file: rel, ...p });
  }
  return { texts, problems, ignored };
}

function expand(args) {
  if (!args.length) return sourceFiles();
  const out = [];
  for (const a of args) {
    const p = resolve(process.cwd(), a);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else out.push(p);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const showIgnored = args.includes('--ignored');
  const files = expand(args.filter((a) => !a.startsWith('--')));
  const { texts, problems, ignored } = checkFiles(files);
  for (const x of texts) console.log(`${x.file}:${x.line}: not translated (${x.reason}${x.call ? `, ${x.call}()` : ''}): ${JSON.stringify(x.value).slice(0, 160)}`);
  for (const p of problems) console.log(`${p.file}:${p.line}: ${p.problem}`);
  if (showIgnored) for (const x of ignored) console.log(`${x.file}:${x.line}: ignored (${x.reason}): ${JSON.stringify(x.value).slice(0, 120)}`);
  console.log(`i18n check: ${files.filter((f) => guarded(relSrc(f))).length} files, ${texts.length} texts not translated, ${problems.length} problems, ${ignored.length} ignored by pragma`);
  if (texts.length || problems.length) process.exitCode = 1;
}

void SRC;
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
