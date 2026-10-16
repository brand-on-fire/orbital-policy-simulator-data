import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, formatCsv, CsvError } from '../scripts/lib/csv.mjs';
import { fixture } from './helpers.mjs';

test('parses the verbatim CelesTrak GP CSV capture (CRLF, no quoting)', () => {
  const { header, rows } = parseCsv(fixture('celestrak/raw-gp-catnr-25544.csv'));
  assert.equal(header.length, 17);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'ISS (ZARYA)');
  assert.equal(rows[0][14], '.1033021E-3');
});

test('parses the verbatim SupGP capture with its 19 columns', () => {
  const { header, rows } = parseCsv(fixture('celestrak/raw-supgp-iss-e.csv'));
  assert.equal(header.at(-1), 'DATA_SOURCE');
  assert.equal(rows.length, 60);
  assert.ok(rows.every((row) => row.length === 19));
});

test('handles quoted fields, escaped quotes, embedded commas and newlines', () => {
  const { rows } = parseCsv('A,B,C\r\n"x, y","say ""hi""","line1\nline2"\r\n');
  assert.deepEqual(rows, [['x, y', 'say "hi"', 'line1\nline2']]);
});

test('accepts LF line endings and a final record without a newline', () => {
  assert.deepEqual(parseCsv('A,B\n1,2').rows, [['1', '2']]);
  assert.deepEqual(parseCsv('A,B\n1,\n').rows, [['1', '']]);
});

test('rejects malformed CSV', () => {
  const bad = {
    empty: '',
    bom: '\ufeffA,B\r\n1,2\r\n',
    nul: 'A,B\r\n1,\u00002\r\n',
    bareCr: 'A,B\r1,2\r\n',
    blankLine: 'A,B\r\n\r\n1,2\r\n',
    ragged: 'A,B\r\n1,2,3\r\n',
    shortRow: 'A,B\r\n1\r\n',
    strayQuote: 'A,B\r\n1"x,2\r\n',
    afterQuote: 'A,B\r\n"1"x,2\r\n',
    unterminated: 'A,B\r\n"1,2\r\n',
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.throws(() => parseCsv(text), CsvError, name);
  }
});

test('formatCsv round-trips through the strict parser', () => {
  const rows = [['a,b', 'q"t', ''], ['1', '2', '3']];
  assert.deepEqual(parseCsv(formatCsv(['X', 'Y', 'Z'], rows)).rows, rows);
});
