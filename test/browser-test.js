#!/usr/bin/env node
// End-to-end check of the site in headless Chromium.
//
//   node test/browser-test.js            # tests site/index.html from disk
//   node test/browser-test.js <url>      # tests a deployed copy
//
// Needs Playwright (`npm install --no-save playwright` if it isn't available).
'use strict';
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const URL = process.argv[2] || 'file://' + path.resolve(__dirname, '..', 'site', 'index.html');
// 26 Oct 2026, 12:04:30 in California. The UK has left summer time; the US hasn't.
const NOW = new Date('2026-10-26T19:04:30Z');

const cardTexts = page => page.$$eval('.card', cs => cs.map(c => ({
  title: c.querySelector('.card-title').textContent,
  lines: [...c.querySelectorAll('.card-line')].map(l => l.textContent),
  date: c.querySelector('.card-date').textContent,
  night: c.querySelector('.clock').classList.contains('night'),
})));

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
    colorScheme: 'dark',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.install({ time: NOW });
  await page.goto(URL);

  // Defaults, in offset order, with times relative to local time.
  await page.click('#fmt-24');
  let cards = await cardTexts(page);
  if (process.env.DEBUG) console.log(cards);
  assert.deepEqual(cards.map(c => c.title), ['Los Angeles, 12:04', 'New York, 15:04', 'London, 19:04']);
  assert.deepEqual(cards.map(c => c.lines[0]), ['Today, +0 HRS', 'Today, +3 HRS', 'Today, +7 HRS']);
  assert.deepEqual(cards.map(c => c.night), [false, false, true]);
  const londonRise = cards[2].lines[1].match(/Sunrise: (\d\d):(\d\d)/);
  assert.ok(londonRise, cards[2].lines[1]);
  const riseMin = +londonRise[1] * 60 + +londonRise[2];
  assert.ok(riseMin > 6 * 60 + 35 && riseMin < 6 * 60 + 55, "London sunrise " + londonRise[0]); // ~06:44 GMT
  assert.equal(await page.locator('.pin').count(), 3);
  await page.screenshot({ path: path.join(__dirname, 'screenshot-default.png') });

  // Add Paris and Tokyo from the search dialog.
  await page.click('#add-btn');
  await page.fill('#search', 'paris');
  await page.press('#search', 'Enter');
  await page.click('#add-btn');
  await page.fill('#search', 'japan');
  await page.press('#search', 'Enter');
  cards = await cardTexts(page);
  assert.deepEqual(cards.map(c => c.title.split(',')[0]), ['Los Angeles', 'New York', 'London', 'Paris', 'Tokyo']);
  assert.equal(cards[4].lines[0], 'Tomorrow, +16 HRS');

  // Search by country alias and time zone name.
  await page.click('#add-btn');
  await page.fill('#search', 'uk');
  assert.ok(await page.locator('.results button', { hasText: 'Edinburgh' }).count() > 0);
  await page.fill('#search', 'pacific standard');
  assert.ok(await page.locator('.results button', { hasText: 'Seattle' }).count() > 0);
  await page.keyboard.press('Escape');

  // Remove New York; the selection survives a reload.
  await page.click('.card:nth-child(2) .card-remove', { force: true });
  await page.reload();
  cards = await cardTexts(page);
  assert.deepEqual(cards.map(c => c.title), ['Los Angeles, 12:04', 'London, 19:04', 'Paris, 20:04', 'Tokyo, 04:04']);

  // 12-hour format is remembered too.
  await page.click('#fmt-12');
  await page.reload();
  assert.equal((await cardTexts(page))[0].title, 'Los Angeles, 12:04 PM');
  await page.click('#fmt-24');

  // Convert 09:00 on 30 Oct in London.
  await page.selectOption('#conv-zone', 'Europe/London');
  await page.fill('#conv-date', '2026-10-30');
  await page.fill('#conv-time', '09:00');
  cards = await cardTexts(page);
  assert.deepEqual(cards.map(c => c.title), ['Los Angeles, 02:00', 'London, 09:00', 'Paris, 10:00', 'Tokyo, 18:00']);
  assert.deepEqual(cards.map(c => c.lines[0]), ['Today, −7 HRS', 'Today, +0 HRS', 'Today, +1 HR', 'Today, +9 HRS']);
  assert.equal(cards[1].date, 'Fri, Oct 30');
  assert.equal(await page.textContent('#status-text'), 'Chosen time');
  assert.match(page.url(), /#t=2026-10-30T09%3A00&z=Europe%2FLondon$/);

  // Across the US DST change: 09:00 on 2 Nov in London is 01:00 in LA.
  await page.fill('#conv-date', '2026-11-02');
  assert.equal((await cardTexts(page))[0].title, 'Los Angeles, 01:00');

  // A shared link reproduces the chosen time, even for a city not in the list.
  await page.goto(URL + '#t=2026-10-26T15:00&z=America%2FNew_York');
  await page.reload();
  cards = await cardTexts(page);
  assert.equal(cards[0].title, 'Los Angeles, 12:00');
  assert.equal(await page.inputValue('#conv-zone'), 'America/New_York');
  await page.screenshot({ path: path.join(__dirname, 'screenshot-converted.png') });

  // Back to now.
  await page.click('#conv-now');
  assert.equal(await page.textContent('#status-text'), 'Live');
  assert.equal((await cardTexts(page))[0].title, 'Los Angeles, 12:04');
  assert.ok(!page.url().includes('#t='));

  // Phone-sized layout doesn't scroll sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, 'horizontal overflow ' + overflow);
  await page.screenshot({ path: path.join(__dirname, 'screenshot-phone.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(__dirname, 'screenshot-phone-light.png'), fullPage: true });

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('ok');
})().catch(e => { console.error(e); process.exit(1); });
