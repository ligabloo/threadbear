import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { ThreadbearWorld } from '../support/world.ts';

// File > Import from Claude Code… (desktop/gpui/src/import_sheet.rs). The dump's
// `importSheet` has each row's title, its tick and how its import went; the
// `import` command opens the sheet and ticks, sets switches and presses Import.

When('I open the Import from Claude Code sheet', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'import' });
  await this.until('the import sheet listed', (d) => d.importSheet && !d.importSheet.loading);
});

When('I show archived sessions in the import sheet', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'import', archived: true });
  await this.until('the import sheet listed again', (d) => d.importSheet && !d.importSheet.loading && d.importSheet.includeArchived);
});

When('I tick {string} and {string} in the import sheet', async function (this: ThreadbearWorld, a: string, b: string) {
  await this.app.do({ cmd: 'import', pick: a });
  await this.app.do({ cmd: 'import', pick: b });
});

When('I tick {string} in the import sheet', async function (this: ThreadbearWorld, a: string) {
  await this.app.do({ cmd: 'import', pick: a });
});

When('I select all in the import sheet', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'import', all: true });
});

When('I press Import in the import sheet', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'import', go: true });
});

Then('the import sheet lists {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`${title} in the import sheet`, (d) => d.importSheet?.rows.some((r) => r.title === title));
});

Then('the import sheet does not list {string}', async function (this: ThreadbearWorld, title: string) {
  const d = await this.app.dump();
  assert.ok(d.importSheet, 'the import sheet is up');
  assert.ok(!d.importSheet.rows.some((r) => r.title === title), `${title} is listed`);
});

Then("the import sheet's button is {string} and can't be pressed", async function (this: ThreadbearWorld, label: string) {
  await this.until(`${label} greyed`, (d) => d.importSheet?.button === label && !d.importSheet.canImport);
});

Then("the import sheet's button is {string} and can be pressed", async function (this: ThreadbearWorld, label: string) {
  await this.until(`${label} ready`, (d) => d.importSheet?.button === label && d.importSheet.canImport);
});

Then("the import sheet's row {string} is imported", async function (this: ThreadbearWorld, title: string) {
  await this.until(`${title} imported`, (d) => d.importSheet?.rows.find((r) => r.title === title)?.state === 'done');
});

Then("the import sheet's row {string} says {string}", async function (this: ThreadbearWorld, title: string, words: string) {
  await this.until(`${title} says ${words}`, (d) => d.importSheet?.rows.find((r) => r.title === title)?.error?.includes(words));
});

Then('the import sheet lists {string} under {string}', async function (this: ThreadbearWorld, child: string, parent: string) {
  await this.until(`${child} under ${parent}`, (d) => {
    const rows = d.importSheet?.rows ?? [];
    const at = rows.findIndex((r) => r.title === parent);
    return at >= 0 && rows[at + 1]?.title === child && rows[at + 1].depth === rows[at].depth + 1;
  });
});

Then("the import sheet's row {string} comes along", async function (this: ThreadbearWorld, title: string) {
  await this.until(`${title} coming along`, (d) => d.importSheet?.rows.find((r) => r.title === title)?.implied);
});
