#!/usr/bin/env python3
"""
Convert the reply-review workbook into a JSON test fixture.

Development only: nothing in the application reads spreadsheets. Run it when the workbook
changes, then review the fixture diff:

    python3 scripts/reply-workbook-fixture.py ~/Downloads/100_Email_Examples_Reply_Review.xlsx

The workbook is read, never modified. Every column is kept separate so a test can give the
classifier the email alone, or the email plus the recipient context as a distinct trusted
input, and never leak the expected label, rationale or suggested action into either.
Standard library only, so evaluation adds no dependency to the project.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
COLUMNS = {
    'A': 'id', 'B': 'expected', 'C': 'importance', 'D': 'subject', 'E': 'email',
    'F': 'why', 'G': 'action', 'H': 'category', 'I': 'recipientContext',
    'J': 'sourceType', 'K': 'sourceSection', 'L': 'sourceUrl',
    'M': 'yourDecision', 'N': 'yourNotes',
}
LABELS = {'Yes': 'yes', 'No': 'no', 'Not urgent reply': 'routine'}


def cell_text(cell, shared):
    kind = cell.get('t')
    if kind == 'inlineStr':
        return ''.join(t.text or '' for t in cell.iter(f'{{{NS["x"]}}}t'))
    value = cell.find('x:v', NS)
    if value is None or value.text is None:
        return ''
    if kind == 's':
        return shared[int(value.text)]
    return value.text


def main(path, out):
    with zipfile.ZipFile(path) as book:
        shared = []
        if 'xl/sharedStrings.xml' in book.namelist():
            root = ET.fromstring(book.read('xl/sharedStrings.xml'))
            shared = [''.join(t.text or '' for t in item.iter(f'{{{NS["x"]}}}t')) for item in root.findall('x:si', NS)]
        sheet = ET.fromstring(book.read('xl/worksheets/sheet1.xml'))
    rows = []
    for row in sheet.find('x:sheetData', NS).findall('x:row', NS):
        values = {}
        for cell in row.findall('x:c', NS):
            column = re.match(r'[A-Z]+', cell.get('r')).group(0)
            if column in COLUMNS:
                values[COLUMNS[column]] = cell_text(cell, shared)
        if values.get('id', '').startswith('E'):
            rows.append(values)
    for row in rows:
        if row['expected'] not in LABELS:
            raise SystemExit(f'{row["id"]}: unknown label {row["expected"]!r}')
        row['expected'] = LABELS[row['expected']]
        row['importance'] = int(float(row['importance']))
        for key in COLUMNS.values():
            row.setdefault(key, '')
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump({'source': 'Reply review workbook (adapted examples; fictional names and addresses)',
                   'rows': rows}, handle, ensure_ascii=False, indent=1)
        handle.write('\n')
    counts = {label: sum(1 for r in rows if r['expected'] == label) for label in LABELS.values()}
    print(f'{len(rows)} rows -> {out} {counts}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'tests/fixtures/reply-workbook.json')
