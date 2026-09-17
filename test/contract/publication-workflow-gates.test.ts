import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import test from "node:test";
import {parse} from "yaml";
const root = resolve(import.meta.dirname, '../..');

test('Template and Skill workflows cryptographically authenticate inputs before upload or publication', async () => {
  for (const [file, verifier] of [['release-template.yml','verify-template-publication.mjs'],['release-skill.yml','verify-skill-publication.mjs']] as const) {
    const workflow=parse(await readFile(resolve(root,'.github/workflows',file),'utf8'));
    const steps=workflow.jobs.verify.steps as {run?:string; uses?:string}[];
    const gate=steps.findIndex(s => s.run?.includes(verifier));
    assert.ok(gate >= 0, `${file} requires crypto gate`);
    const upload=steps.findIndex(s => s.uses?.startsWith('actions/upload-artifact'));
    const publish=steps.findIndex(s=>s.run?.includes('gh release create'));
    assert.ok(gate < upload && gate < publish, `${file}: authenticate before distributing`);
    assert.match(steps[gate]!.run!, /--receipt/);
    assert.match(steps[gate]!.run!, /--tag/);
    assert.match(steps[gate]!.run!, /--archive/, `${file}: authenticate the final archive, not only checkout metadata`);
  }
});

test('CLI workflows verify embedded template receipt before packaging and at downloaded-byte gates', async () => {
  const workflow=parse(await readFile(resolve(root,'.github/workflows/release-cli.yml'),'utf8'));
  for (const job of ['build','verify-draft-assets','publish']) {
    const steps=workflow.jobs[job].steps as {run?:string;uses?:string}[];
    const gate=steps.findIndex(s=>s.run?.includes('verify-template-publication.mjs'));
    assert.ok(gate>=0, `${job}: template signature gate required`);
    if(job==='build') assert.ok(gate < steps.findIndex(s=>s.run?.includes('scripts/package-portable.mjs')));
    if(job==='publish') assert.ok(gate < steps.findIndex(s=>s.run?.includes('gh release create')));
  }
});


test('Skill receipt bytes bind a reproducibly packaged archive, not wall-clock zip output', async()=>{
  const text=await readFile(resolve(root,'.github/workflows/release-skill.yml'),'utf8');
  assert.match(text,/scripts\/package-skill-archive\.mjs/);
  assert.doesNotMatch(text,/zip -X -q -r/);
});
