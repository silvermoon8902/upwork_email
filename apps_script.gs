// ===== Upwork → GitHub email harvester: Google Sheet sink =====
// Deploy: Apps Script editor → Deploy → New deployment → Web app
//   Execute as: Me   |   Who has access: Anyone
// Copy the /exec URL into the extension's "POST endpoint" field.

const SHEET_NAME = 'Candidates';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize concurrent POSTs so rows don't collide
  try {
    const data = JSON.parse(e.postData.contents);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow([
        'Timestamp', 'Upwork Name', 'Upwork Profile', 'GitHub Profile',
        'Email', 'Job Success', 'Badge', 'Hourly Rate', 'Total Earning'
      ]);
    }

    // De-dupe on email.
    if (data.email_address) {
      const last = sheet.getLastRow();
      if (last > 1) {
        const existing = sheet.getRange(2, 5, last - 1, 1).getValues().flat();
        if (existing.indexOf(data.email_address) !== -1) {
          return json({ status: 'duplicate', email: data.email_address });
        }
      }
    }

    sheet.appendRow([
      new Date(),
      data.upwork_name         || '',
      data.upwork_profile_link || '',
      data.github_profile_link || '',
      data.email_address       || '',
      data.job_success_score   || '',
      data.badge               || '',
      data.hourly_rate         || '',
      data.total_earning       || ''
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
