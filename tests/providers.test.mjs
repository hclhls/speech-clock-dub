import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXT, loadProviders } from './helpers/load-background.mjs';

const PROV = loadProviders();
const plain = (x) => JSON.parse(JSON.stringify(x));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

test('the adapter is chosen by host name', () => {
  assert.equal(PROV.pick({ hostname: 'www.youtube.com' }).id, 'youtube');
  assert.equal(PROV.pick({ hostname: 'm.youtube.com' }).id, 'youtube');
  assert.equal(PROV.pick({ hostname: 'www.udemy.com' }).id, 'udemy');
  assert.equal(PROV.pick({ hostname: 'acme.udemy.com' }).id, 'udemy');
  assert.equal(PROV.pick({ hostname: 'notudemy.com' }).id, 'youtube'); // unknown hosts fall back
});

test('the video key follows the watch address', () => {
  assert.equal(PROV.pick({ hostname: 'www.youtube.com' }).videoKey({ search: '?v=abc&t=3' }), 'abc');
  const udemy = PROV.pick({ hostname: 'www.udemy.com' });
  assert.equal(udemy.videoKey({ pathname: '/course/x/learn/lecture/1' }), '/course/x/learn/lecture/1');
  assert.notEqual(udemy.videoKey({ pathname: '/course/x/learn/lecture/2' }), '/course/x/learn/lecture/1');
});

test('WebVTT is parsed into json3-style events', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000 align:start\n<v Bob>Hello <b>world</b>\n\n01:00.000 --> 01:02.250\nSecond';
  assert.deepEqual(plain(PROV.parseCaptionFile('a.vtt', vtt)), [
    { tStartMs: 1500, dDurationMs: 1500, segs: [{ utf8: 'Hello world' }] },
    { tStartMs: 60000, dDurationMs: 2250, segs: [{ utf8: 'Second' }] },
  ]);
});

test('SRT commas and CRLF line endings are accepted', () => {
  const srt = '1\r\n00:00:00,000 --> 00:00:02,000\r\nHi\r\n';
  assert.deepEqual(plain(PROV.parseCaptionFile('a.srt', srt)), [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hi' }] }]);
});

test('every site the manifest matches has an adapter, and providers.js loads before content.js', () => {
  const entries = manifest.content_scripts.filter((cs) => cs.js.includes('content.js'));
  assert.ok(entries.length >= 2);
  for (const content of entries) {
    assert.ok(content.js.indexOf('providers.js') >= 0 && content.js.indexOf('providers.js') < content.js.indexOf('content.js'));
    for (const m of content.matches) {
      const hostname = new URL(m.replace('*.', 'www.')).hostname;
      assert.ok(PROV.providers.some((p) => p.matches({ hostname })), `no adapter for ${m}`);
    }
  }
});

test('the Vimeo adapter only runs in player frames, which the manifest covers in all frames', () => {
  assert.equal(PROV.pick({ hostname: 'player.vimeo.com' }).id, 'vimeo');
  assert.equal(PROV.pick({ hostname: 'vimeo.com' }).id, 'youtube'); // the page itself has no <video>
  const entry = manifest.content_scripts.find((cs) => cs.matches.includes('https://player.vimeo.com/*'));
  assert.equal(entry.all_frames, true);
  assert.ok(entry.js.includes('content.js'));
});

test('a Vimeo player address yields the video id', () => {
  assert.equal(PROV.vimeoVideoId('/video/76979871'), '76979871');
  assert.equal(PROV.vimeoVideoId('/video/76979871/config'), '76979871');
  assert.equal(PROV.vimeoVideoId('/'), null);
});

test('the Vimeo track list prefers human-made captions over auto-generated ones', () => {
  const tracks = [
    { lang: 'en-x-autogen', kind: 'subtitles', url: '/texttrack/1.vtt' },
    { lang: 'en', kind: 'captions', url: '/texttrack/2.vtt' },
    { lang: 'fr', kind: 'subtitles', url: '/texttrack/3.vtt' },
    { lang: 'de', kind: 'chapters', url: '/texttrack/4.vtt' },
  ];
  assert.equal(PROV.pickVimeoTrack(tracks).url, '/texttrack/2.vtt');
  assert.equal(PROV.pickVimeoTrack([tracks[0], tracks[3]]).url, '/texttrack/1.vtt'); // only auto-generated left
  assert.equal(PROV.pickVimeoTrack([{ lang: 'en', kind: 'captions' }]), null); // no file
  assert.equal(PROV.pickVimeoTrack(undefined), null);
});

test('a Udemy lecture address yields the course slug and lecture id', () => {
  assert.deepEqual(plain(PROV.udemyLectureRef('/course/my-course/learn/lecture/21989274')), {
    slug: 'my-course',
    lectureId: '21989274',
  });
  assert.deepEqual(plain(PROV.udemyLectureRef('/course/my-course/learn/lecture/21989274/')), {
    slug: 'my-course',
    lectureId: '21989274',
  });
  assert.equal(PROV.udemyLectureRef('/course/my-course/'), null);
  assert.equal(PROV.udemyLectureRef('/'), null);
});

test('the Udemy caption list yields one usable track, preferring the first listed', () => {
  const caps = [
    { url: '', locale_id: 'ja_JP' }, // no file: skipped
    { url: 'https://x/en.vtt', locale_id: 'en_US' },
    { url: 'https://x/fr.vtt', locale_id: 'fr_FR' },
  ];
  assert.deepEqual(plain(PROV.pickUdemyCaption(caps)), { url: 'https://x/en.vtt', languageCode: 'en-US' });
  assert.equal(PROV.pickUdemyCaption([]), null);
  assert.equal(PROV.pickUdemyCaption(undefined), null);
});
