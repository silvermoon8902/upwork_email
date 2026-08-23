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

// The POST body carries more fields than this (Upwork name, LinkedIn profile,
// education, match source, email-verified flag). The sink deliberately selects
// a subset -- to surface one of the others, add it here and to appendRow below,
// bump EMAIL_COL if the Email position moves, then rename the sheet.
const HEADER = [
  'Full Name', 'Upwork Profile', 'Email', 'Match Confidence',
  'Job Success', 'Badge', 'Hourly Rate', 'Total Earning',
  'Last Completed', 'Last Hired'
];

const EMAIL_COL = 3;   // must match HEADER's 'Email' position -- dedupe reads this column

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

    // De-dupe on email, case-insensitively: the same address in different
    // casing is the same person and must not be contacted twice.
    const email = String(data.email_address || '').trim();
    if (email) {
      const last = sheet.getLastRow();
      if (last > 1) {
        const seen = sheet.getRange(2, EMAIL_COL, last - 1, 1).getValues()
          .map(function (row) { return String(row[0]).trim().toLowerCase(); });
        if (seen.indexOf(email.toLowerCase()) !== -1) {
          return json({ status: 'duplicate', email: email });
        }
      }
    }

    sheet.appendRow([
      data.full_name             || '',
      data.upwork_profile_link   || '',
      email,
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
