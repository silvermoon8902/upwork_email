// ===== Upwork -> ContactOut harvester: Google Sheet sink =====
// Deploy: Apps Script editor -> Deploy -> New deployment -> Web app
//   Execute as: Me   |   Who has access: Anyone
// Copy the /exec URL into the extension's "POST endpoint" field.
//
// The column layout has changed across versions. doPost refuses to append to a
// sheet whose header doesn't match HEADER exactly, rather than writing
// misaligned rows -- so after any change here, rename the old sheet and let the
// script recreate it.

const SHEET_NAME = 'Candidates';

// The POST body carries more fields than this (LinkedIn profile, education,
// match source, email-verified flag). The sink deliberately selects a subset --
// to surface one of the others, add it here and to appendRow below, bump
// EMAIL_COL if the Email position moves, then rename the sheet.
//
// Column 1 joins ContactOut's full name to Upwork's truncated one so a match
// can be judged by eye against its confidence score; column 3 is the matched
// ContactOut avatar, which =IMAGE(C2) will render inline in the sheet.
const HEADER = [
  'Contactout Full Name | Upwork Full Name', 'Country', 'Upwork Profile',
  'Contactout Image URL', 'Email', 'Match Confidence',
  'Job Success', 'Badge', 'Hourly Rate', 'Total Earning',
  'Last Completed', 'Last Hired'
];

const EMAIL_COL = 5;   // must match HEADER's 'Email' position -- dedupe reads this column

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // serialize concurrent POSTs so rows don't collide
  } catch (err) {
    // Nothing acquired, so nothing to release.
    return json({ status: 'error', message: 'could not acquire lock' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ status: 'error', message: 'no POST body' });
    }
    const data = JSON.parse(e.postData.contents);

    let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_NAME);

    // Covers both a freshly inserted sheet and one that exists but is empty --
    // the latter would otherwise take data rows with no header at all.
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADER);
    } else {
      // Any drift means appendRow would write into the wrong columns.
      const existing = sheet.getRange(1, 1, 1, HEADER.length).getValues()[0];
      if (existing.join('|') !== HEADER.join('|')) {
        return json({
          status: 'error',
          message: 'sheet header does not match this version - rename the sheet and let the script recreate it'
        });
      }
    }

    // A ContactOut card often lists several addresses (personal + work) and all
    // of them are kept, comma-separated, in the one Email cell.
    const emails = (Array.isArray(data.all_emails) && data.all_emails.length
        ? data.all_emails
        : [data.email_address])
      .map(function (e) { return String(e || '').trim().toLowerCase(); })
      .filter(String)
      .filter(function (e, i, a) { return a.indexOf(e) === i; });

    // De-dupe case-insensitively, and split existing cells on their separators:
    // a stored cell can hold several addresses, so an exact whole-cell compare
    // would miss a person already present under their second address.
    if (emails.length) {
      const last = sheet.getLastRow();
      if (last > 1) {
        const seen = {};
        sheet.getRange(2, EMAIL_COL, last - 1, 1).getValues().forEach(function (row) {
          String(row[0]).split(/[,;\s]+/).forEach(function (e) {
            const t = e.trim().toLowerCase();
            if (t) seen[t] = true;
          });
        });
        for (var i = 0; i < emails.length; i++) {
          if (seen[emails[i]]) return json({ status: 'duplicate', email: emails[i] });
        }
      }
    }

    // Both names in one cell so a match can be eyeballed against its confidence
    // score. ContactOut's first, since that is the identity being asserted.
    const names = [data.full_name, data.upwork_name]
      .map(function (n) { return String(n || '').trim(); })
      .filter(String)
      .join(' | ');

    sheet.appendRow([
      names,
      data.upwork_country        || '',
      data.upwork_profile_link   || '',
      data.contactout_image_url  || '',
      emails.join(', '),
      data.match_confidence      || '',
      data.job_success_score     || '',
      data.badge                 || '',
      data.hourly_rate           || '',
      data.total_earning         || '',
      data.last_completed_end    || '',
      data.last_hired_start      || ''
    ]);

    return json({ status: 'ok' });
  } catch (err) {
    return json({ status: 'error', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
