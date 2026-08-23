// ===== Upwork → ContactOut harvester: Google Sheet sink =====
// Deploy: Apps Script editor → Deploy → New deployment → Web app
//   Execute as: Me   |   Who has access: Anyone
// Copy the /exec URL into the extension's "POST endpoint" field.
//
// NOTE: the column layout changed in v0.2 (GitHub → LinkedIn, plus match
// columns). If you have a v0.1 'Candidates' sheet, rename it before running —
// doPost refuses to append to a sheet whose header doesn't match rather than
// writing misaligned rows.

const SHEET_NAME = 'Candidates';

const HEADER = [
  'Timestamp', 'Upwork Name', 'Upwork Profile', 'LinkedIn Profile',
  'Email', 'Full Name', 'Education', 'Match Confidence', 'Match Source',
  'Job Success', 'Badge', 'Hourly Rate', 'Total Earning'
];

const EMAIL_COL = 5;   // must match HEADER's 'Email' position — dedupe reads this column

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // serialize concurrent POSTs so rows don't collide
  } catch (err) {
    return json({ status: 'error', message: 'could not acquire lock' });
  }

  try {
    const data = JSON.parse(e.postData.contents);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(HEADER);
    } else if (sheet.getLastRow() > 0) {
      const existing = sheet.getRange(1, 1, 1, HEADER.length).getValues()[0];
      if (existing[3] !== HEADER[3]) {
        return json({
          status: 'error',
          message: 'sheet has the old v0.1 header — rename it and let the script recreate it'
        });
      }
    }

    // De-dupe on email.
    if (data.email_address) {
      const last = sheet.getLastRow();
      if (last > 1) {
        const seen = sheet.getRange(2, EMAIL_COL, last - 1, 1).getValues().flat();
        if (seen.indexOf(data.email_address) !== -1) {
          return json({ status: 'duplicate', email: data.email_address });
        }
      }
    }

    sheet.appendRow([
      new Date(),
      data.upwork_name           || '',
      data.upwork_profile_link   || '',
      data.linkedin_profile_link || '',
      data.email_address         || '',
      data.full_name             || '',
      data.education             || '',
      data.match_confidence      || '',
      data.match_source          || '',
      data.job_success_score     || '',
      data.badge                 || '',
      data.hourly_rate           || '',
      data.total_earning         || ''
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
