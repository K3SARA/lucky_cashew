const http = require('http');
const fs = require('fs');
const path = require('path');
const { test, expect, webkit, devices } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
let server;
let baseUrl;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname === '/') filePath = path.join(root, 'index.html');
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function seedInventoryProduct(page, name, billingPrice, stock = 100, invoicePrice = 0) {
  await page.evaluate(async ({ name, stock, billingPrice, invoicePrice }) => {
    await window.db.addProduct(name, stock, billingPrice, invoicePrice, 5);
    await window.billing.refreshProducts();
  }, { name, stock, billingPrice, invoicePrice });
}

test('iPhone receipt preview Back to App returns to billing page', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`tester-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Mobile Test Product', 1500);
  await page.locator('#customer-name').fill('Mobile Test Customer');
  await page.locator('[id^="product-name-"]').first().fill('Mobile Test Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('1500');
  await page.locator('#received-amount').fill('1500');

  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /print receipt/i }).click();
  const receiptPage = await popupPromise;
  await receiptPage.waitForLoadState('domcontentloaded');

  await expect(receiptPage.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(receiptPage.getByRole('button', { name: 'Edit Bill' })).toBeVisible();
  await expect(receiptPage.getByRole('button', { name: 'Back to App' })).toBeVisible();

  await receiptPage.getByRole('button', { name: 'Back to App' }).click();
  await page.waitForTimeout(500);

  if (!receiptPage.isClosed()) {
    await expect(receiptPage.locator('#app')).toBeVisible();
    await expect(receiptPage.locator('#billing-page')).toHaveClass(/active/);
  }

  await expect(page.locator('#billing-page')).toHaveClass(/active/);
  await context.close();
  await browser.close();
});

test('cheque receipt preview shows cheque details', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`cheque-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Cheque Test Product', 2500);
  await page.locator('#customer-name').fill('Cheque Test Customer');
  await page.locator('[id^="product-name-"]').first().fill('Cheque Test Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('2500');
  await page.locator('#received-amount').fill('2500');
  await page.locator('#payment-method').selectOption('cheque');
  await expect(page.locator('#cheque-details')).not.toHaveClass(/hidden/);
  await page.locator('#cheque-date').fill('2026-04-30');
  await page.locator('#cheque-number').fill('CHQ-7788');
  await page.locator('#cheque-bank').fill('People Bank');

  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /print receipt/i }).click();
  const receiptPage = await popupPromise;
  await receiptPage.waitForLoadState('domcontentloaded');

  await expect(receiptPage.getByText('Payment Method')).toBeVisible();
  await expect(receiptPage.getByText('Cheque', { exact: true })).toBeVisible();
  await expect(receiptPage.getByText('Cheque Amount')).toBeVisible();
  await expect(receiptPage.locator('.totals .row').filter({ hasText: 'Cheque Amount' }).getByText('2,500')).toBeVisible();
  await expect(receiptPage.getByText('Cheque Date')).toBeVisible();
  await expect(receiptPage.getByText('2026-04-30')).toBeVisible();
  await expect(receiptPage.getByText('Cheque No')).toBeVisible();
  await expect(receiptPage.getByText('CHQ-7788')).toBeVisible();
  await expect(receiptPage.getByText('People Bank')).toBeVisible();

  await context.close();
  await browser.close();
});

test('decimal amounts do not leave a false due balance', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const customerName = `Decimal Customer ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`decimal-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Decimal Test Product', 100.01);
  await page.locator('#customer-name').fill(customerName);
  await page.locator('[id^="product-name-"]').first().fill('Decimal Test Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('100.01');
  await page.locator('#received-amount').fill('100.01');
  await expect(page.locator('#label-balance')).toHaveText('LKR 0.00');

  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-collection').click();
  await expect(page.locator('#collection-page')).toHaveClass(/active/);
  await expect(page.locator('#collection-list')).not.toContainText(customerName);

  await context.close();
  await browser.close();
});

test('editing a cheque bill updates cheque details', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const originalChequeNo = `CHQ-OLD-${Date.now()}`;
  const updatedChequeNo = `CHQ-NEW-${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`edit-cheque-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Editable Cheque Product', 4200);
  await page.locator('#customer-name').fill('Editable Cheque Customer');
  await page.locator('[id^="product-name-"]').first().fill('Editable Cheque Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('4200');
  await page.locator('#received-amount').fill('4200');
  await page.locator('#payment-method').selectOption('cheque');
  await page.locator('#cheque-date').fill('2026-05-10');
  await page.locator('#cheque-number').fill(originalChequeNo);
  await page.locator('#cheque-bank').fill('BOC');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-history').click();
  await expect(page.locator('#history-page')).toHaveClass(/active/);
  await page.locator('[data-history-action="edit"]').first().click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);
  await expect(page.locator('#payment-method')).toHaveValue('cheque');
  await expect(page.locator('#cheque-number')).toHaveValue(originalChequeNo);

  await page.locator('#cheque-date').fill('2026-05-22');
  await page.locator('#cheque-number').fill(updatedChequeNo);
  await page.locator('#cheque-bank').fill('HNB');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /print receipt/i }).click();
  const receiptPage = await popupPromise;
  await receiptPage.waitForLoadState('domcontentloaded');
  await expect(receiptPage.getByText('2026-05-22')).toBeVisible();
  await expect(receiptPage.getByText(updatedChequeNo)).toBeVisible();
  await expect(receiptPage.getByText('HNB')).toBeVisible();
  await expect(receiptPage.getByText(originalChequeNo)).toHaveCount(0);
  await receiptPage.close();

  await context.close();
  await browser.close();
});

test('PDF buttons preview before downloading report files', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block',
    acceptDownloads: true
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`pdf-preview-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForTimeout(1000); // Wait for navigation
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('sales');

  let popupPromise = page.waitForEvent('popup');
  await page.locator('#reports-view .report-pdf-btn').click();
  let previewPage = await popupPromise;
  await previewPage.waitForLoadState('domcontentloaded');
  await expect(previewPage.getByRole('button', { name: 'Download PDF' })).toBeVisible();
  await expect(previewPage.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(previewPage.getByRole('button', { name: 'Back to App' })).toBeVisible();
  let downloadPromise = previewPage.waitForEvent('download');
  await previewPage.getByRole('button', { name: 'Download PDF' }).click();
  let download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/sales-summary-\d{4}-\d{2}-\d{2}\.pdf/);
  await previewPage.close();

  await page.locator('#nav-inventory').click();
  await expect(page.locator('#inventory-page')).toHaveClass(/active/);
  popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-inventory-pdf').click();
  previewPage = await popupPromise;
  await previewPage.waitForLoadState('domcontentloaded');
  await expect(previewPage.getByRole('button', { name: 'Download PDF' })).toBeVisible();
  await expect(previewPage.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(previewPage.getByRole('button', { name: 'Back to App' })).toBeVisible();
  downloadPromise = previewPage.waitForEvent('download');
  await previewPage.getByRole('button', { name: 'Download PDF' }).click();
  download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/inventory-report-\d{4}-\d{2}-\d{2}\.pdf/);

  await context.close();
  await browser.close();
});
test('reports page shows PDF button for every report', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`reports-pdf-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);

  const values = await page.locator('#reports-type option').evaluateAll((options) => options.map((option) => option.value));
  for (const value of values) {
    await page.locator('#reports-type').selectOption(value);
    const buttons = page.locator('#reports-view .report-pdf-btn');
    if (value === 'dayclose') {
      await expect(buttons).toHaveCount(2);
      await expect(page.locator('#reports-view').getByRole('button', { name: 'Print 80mm' })).toBeVisible();
      await expect(page.locator('#reports-view').getByRole('button', { name: 'Download PDF' })).toBeVisible();
    } else {
      await expect(buttons).toHaveCount(1);
      await expect(buttons.first()).toBeVisible();
    }
  }

  await context.close();
  await browser.close();
});

test('reports notes pad is visible and saves state label', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`reports-note-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await expect(page.locator('#reports-quick-note')).toBeVisible();
  await expect(page.locator('#reports-note-save')).toBeVisible();
  await expect(page.locator('#reports-note-clear')).toBeVisible();

  await page.locator('#reports-quick-note').fill('remember cheque deposit');
  await expect(page.locator('#reports-note-status')).toContainText('Unsaved changes');
  await page.locator('#reports-note-save').click();
  await expect(page.locator('#reports-note-status')).toContainText('Saved');

  await context.close();
  await browser.close();
});

test('day close report opens 80mm print summary', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`dayclose-80mm-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Day Close Product', 2500);
  await page.locator('#customer-name').fill('Day Close Customer');
  await page.locator('[id^="product-name-"]').first().fill('Day Close Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('2500');
  await page.locator('#received-amount').fill('2500');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('dayclose');
  await expect(page.locator('#reports-view').getByRole('button', { name: 'Print 80mm' })).toBeVisible();

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#reports-view').getByRole('button', { name: 'Print 80mm' }).click();
  const printPage = await popupPromise;
  await printPage.waitForLoadState('domcontentloaded');
  await expect(printPage.getByText('Day Summary', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Bill Details', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Payment Method Totals', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Cheque Received', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Credit Given', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Credit Collections', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Profit', { exact: true })).toBeVisible();

  await context.close();
  await browser.close();
});

test('day close 80mm summary uses correct received and credit calculations', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`dayclose-calc-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Day Close Cash Product', 1000);
  await seedInventoryProduct(page, 'Day Close Credit Product', 1500);
  await seedInventoryProduct(page, 'Day Close Partial Cash Product', 800);

  await page.locator('#customer-name').fill('Cash Customer');
  await page.locator('[id^="product-name-"]').first().fill('Day Close Cash Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('1000');
  await page.locator('#received-amount').fill('1000');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#customer-name').fill('Credit Customer');
  await page.locator('[id^="product-name-"]').first().fill('Day Close Credit Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('1500');
  await page.locator('#received-amount').fill('0');
  await page.locator('#payment-method').selectOption('credit');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#customer-name').fill('Partial Cash Customer');
  await page.locator('[id^="product-name-"]').first().fill('Day Close Partial Cash Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('800');
  await page.locator('#received-amount').fill('300');
  await page.locator('#payment-method').selectOption('cash');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-collection').click();
  await expect(page.locator('#collection-page')).toHaveClass(/active/);
  const creditCard = page.locator('#collection-list .card').filter({ hasText: 'Credit Customer' }).first();
  await creditCard.locator('input[id^="collect-amount-"]').fill('500');
  await creditCard.locator('select[id^="collect-method-"]').selectOption('cash');
  await creditCard.locator('[data-collect-id]').click();

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('dayclose');

  const summary = await page.evaluate(() => {
    const data = window.reportsView.getDayClose80mmData(window.reportsView.getRange());
    return {
      totalReceived: data.totalReceived,
      cashReceived: data.cashReceived,
      paymentMethodTotals: data.paymentMethodTotals,
      itemQtyRows: data.itemQtyRows,
      creditGivenTotal: data.creditGivenTotal,
      creditOutstandingTotal: data.creditOutstandingTotal,
      creditCollectedTotal: data.creditCollectedTotal,
      creditCustomers: data.creditBills.map((bill) => bill.customer),
      creditCollectionCustomers: data.creditCollections.map((row) => row.customer)
    };
  });

  expect(summary.totalReceived).toBe(1800);
  expect(summary.cashReceived).toBe(1800);
  expect(summary.paymentMethodTotals.find((item) => item.label === 'Cash')?.amount).toBe(1800);
  expect(summary.paymentMethodTotals.find((item) => item.label === 'Credit')?.amount).toBe(1500);
  expect(summary.itemQtyRows.find((item) => item.name === 'Day Close Cash Product')?.qty).toBe(1);
  expect(summary.itemQtyRows.find((item) => item.name === 'Day Close Credit Product')?.qty).toBe(1);
  expect(summary.itemQtyRows.find((item) => item.name === 'Day Close Partial Cash Product')?.qty).toBe(1);
  expect(summary.creditGivenTotal).toBe(1500);
  expect(summary.creditOutstandingTotal).toBe(1000);
  expect(summary.creditCollectedTotal).toBe(500);
  expect(summary.creditCustomers).toContain('Credit Customer');
  expect(summary.creditCustomers).not.toContain('Partial Cash Customer');
  expect(summary.creditCollectionCustomers).toContain('Credit Customer');
  expect(summary.creditCollectionCustomers).not.toContain('Partial Cash Customer');

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#reports-view').getByRole('button', { name: 'Print 80mm' }).click();
  const printPage = await popupPromise;
  await printPage.waitForLoadState('domcontentloaded');

  await expect(printPage.getByText('Total Received')).toBeVisible();
  await expect(printPage.getByText('Cash', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Credit', { exact: true })).toBeVisible();
  await expect(printPage.getByText('Day Close Cash Product')).toBeVisible();
  await expect(printPage.locator('.row').filter({ hasText: 'Credit Sale Total' }).getByText('1,500')).toBeVisible();
  await expect(printPage.locator('.row').filter({ hasText: 'Credit Outstanding' }).getByText('1,000')).toBeVisible();
  await expect(printPage.locator('.row').filter({ hasText: 'Collected Total' }).getByText('500')).toBeVisible();
  await expect(printPage.getByText('Credit Customer').first()).toBeVisible();
  await expect(printPage.getByText('Partial Cash Customer')).toHaveCount(1);

  await context.close();
  await browser.close();
});
test('cheque report shows completed cheque bill details', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const chequeNo = `CHQ-${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`report-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Report Cheque Product', 3500);
  await page.locator('#customer-name').fill('Report Cheque Customer');
  await page.locator('[id^="product-name-"]').first().fill('Report Cheque Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('3500');
  await page.locator('#received-amount').fill('3500');
  await page.locator('#payment-method').selectOption('cheque');
  await page.locator('#cheque-date').fill('2026-05-05');
  await page.locator('#cheque-number').fill(chequeNo);
  await page.locator('#cheque-bank').fill('Commercial Bank');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('cheques');

  await expect(page.locator('#reports-view')).toContainText('Cheque Details');
  await expect(page.locator('#reports-view')).toContainText('Bill No.');
  await expect(page.locator('#reports-view')).toContainText('C.Name');
  await expect(page.locator('#reports-view')).toContainText('Report Cheque Customer');
  await expect(page.locator('#reports-view')).toContainText('2026-05-05');
  await expect(page.locator('#reports-view')).toContainText('LKR 3,500');
  await expect(page.locator('#reports-view')).toContainText('pending');
  await expect(page.locator('#reports-view')).toContainText('Cheque No.');
  await expect(page.locator('#reports-view')).toContainText(chequeNo);
  await expect(page.locator('#reports-view')).toContainText('Commercial Bank');

  await context.close();
  await browser.close();
});

test('cheque report filters by cheque date, not only bill date', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const chequeNo = `CHQ-DATE-${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`cheque-date-report-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Cheque Date Filter Product', 3600);
  await page.locator('#customer-name').fill('Cheque Date Filter Customer');
  await page.locator('[id^="product-name-"]').first().fill('Cheque Date Filter Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('3600');
  await page.locator('#received-amount').fill('3600');
  await page.locator('#payment-method').selectOption('cheque');
  await page.locator('#cheque-date').fill('2026-04-28');
  await page.locator('#cheque-number').fill(chequeNo);
  await page.locator('#cheque-bank').fill('Sampath Bank');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.evaluate(async () => {
    const bills = await window.db.getBills();
    const bill = bills.find((entry) => entry.customerName === 'Cheque Date Filter Customer');
    if (!bill) throw new Error('Test bill not found');
    await window.db.updateBill(bill.id, {
      timestamp: new Date('2026-03-05T12:00:00').getTime(),
      date: '2026-03-05'
    });
  });

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('cheques');
  await page.locator('#reports-period').selectOption('this_month');

  await expect(page.locator('#reports-view')).toContainText('Cheque Details');
  await expect(page.locator('#reports-view')).toContainText('Cheque Date Filter Customer');
  await expect(page.locator('#reports-view')).toContainText('2026-04-28');
  await expect(page.locator('#reports-view')).toContainText(chequeNo);
  await expect(page.locator('#reports-view')).toContainText('Sampath Bank');

  await context.close();
  await browser.close();
});

test('billing supports multiple cheque payments on one bill', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const productName = `Split Cheque Product ${Date.now()}`;
  const chequeOne = `CHQ-A-${Date.now()}`;
  const chequeTwo = `CHQ-B-${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`split-cheque-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, productName, 15000);
  await page.locator('#customer-name').fill('Split Cheque Customer');
  await page.locator('[id^="product-name-"]').first().fill(productName);
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('15000');
  await page.locator('#received-amount').fill('3000');

  await page.locator('#btn-add-payment-method').click();
  let rows = page.locator('#split-payments-list .split-payment-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('[data-payment-field="method"]')).toHaveValue('cash');
  await expect(rows.nth(0).locator('[data-payment-field="amount"]')).toHaveValue('3000');

  await rows.nth(1).locator('[data-payment-field="method"]').selectOption('cheque');
  await rows.nth(1).locator('[data-payment-field="amount"]').fill('5000');
  await rows.nth(1).locator('[data-payment-field="chequeDate"]').fill('2026-05-01');
  await rows.nth(1).locator('[data-payment-field="chequeNumber"]').fill(chequeOne);
  await rows.nth(1).locator('[data-payment-field="chequeBank"]').fill('Commercial Bank');

  await page.locator('[data-add-payment-row]').click();
  rows = page.locator('#split-payments-list .split-payment-row');
  await rows.nth(2).locator('[data-payment-field="method"]').selectOption('cheque');
  await rows.nth(2).locator('[data-payment-field="amount"]').fill('7000');
  await rows.nth(2).locator('[data-payment-field="chequeDate"]').fill('2026-05-15');
  await rows.nth(2).locator('[data-payment-field="chequeNumber"]').fill(chequeTwo);
  await rows.nth(2).locator('[data-payment-field="chequeBank"]').fill('People Bank');

  await expect(rows.nth(1).locator('label', { hasText: 'Cheque Amount' })).toBeVisible();
  await expect(rows.nth(2).locator('label', { hasText: 'Cheque Amount' })).toBeVisible();
  await expect(page.locator('#received-amount')).toHaveValue('15000.00');
  await expect(page.locator('#label-balance')).toHaveText('LKR 0.00');

  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /print receipt/i }).click();
  const receiptPage = await popupPromise;
  await receiptPage.waitForLoadState('domcontentloaded');
  await expect(receiptPage.getByText('Payment Methods')).toBeVisible();
  await expect(receiptPage.getByText('Cheque 1')).toBeVisible();
  await expect(receiptPage.getByText(chequeOne)).toBeVisible();
  await expect(receiptPage.getByText('Cheque 2')).toBeVisible();
  await expect(receiptPage.getByText(chequeTwo)).toBeVisible();
  await expect(receiptPage.locator('.totals .row').filter({ hasText: 'Cash' }).getByText('3,000')).toBeVisible();
  await expect(receiptPage.locator('.totals .row').filter({ hasText: 'Received' })).toHaveCount(0);
  await expect(receiptPage.locator('.totals .row').filter({ hasText: 'Payment Status' })).toHaveCount(0);
  await expect(receiptPage.locator('.totals .row').filter({ hasText: 'Balance' }).getByText('0')).toBeVisible();
  await receiptPage.close();

  await page.locator('#share-modal .btn-primary').last().click();
  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('cheques');
  await expect(page.locator('#reports-view')).toContainText(chequeOne);
  await expect(page.locator('#reports-view')).toContainText(chequeTwo);
  await expect(page.locator('#reports-view tbody tr')).toHaveCount(2);

  await context.close();
  await browser.close();
});
test('collection cheque payment saves details for cheque report', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`collect-cheque-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Collection Cheque Product', 4200);
  await page.locator('#customer-name').fill('Collection Cheque Customer');
  await page.locator('[id^="product-name-"]').first().fill('Collection Cheque Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('4200');
  await page.locator('#received-amount').fill('0');
  await page.locator('#payment-method').selectOption('credit');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-collection').click();
  await expect(page.locator('#collection-page')).toHaveClass(/active/);
  await expect(page.locator('#collection-list')).toContainText('Collection Cheque Customer');

  await page.locator('[id^="collect-amount-"]').first().fill('4200');
  await page.locator('[id^="collect-method-"]').first().selectOption('cheque');
  await expect(page.locator('[id^="collect-cheque-details-"]').first()).not.toHaveClass(/hidden/);
  await page.locator('[id^="collect-cheque-date-"]').first().fill('2026-06-06');
  await page.locator('[id^="collect-cheque-number-"]').first().fill('COL-8899');
  await page.locator('[id^="collect-cheque-bank-"]').first().fill('Sampath Bank');
  await page.getByRole('button', { name: 'Collect' }).first().click();
  await expect(page.locator('#collection-list')).toContainText('No pending collections');

  await page.locator('#nav-reports').click();
  await expect(page.locator('#reports-page')).toHaveClass(/active/);
  await page.locator('#reports-type').selectOption('cheques');

  await expect(page.locator('#reports-view')).toContainText('Collection Cheque Customer');
  await expect(page.locator('#reports-view')).toContainText('2026-06-06');
  await expect(page.locator('#reports-view')).toContainText('LKR 4,200');
  await expect(page.locator('#reports-view')).toContainText('pending');

  await context.close();
  await browser.close();
});

test('concurrent collections on one bill keep the correct balance', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`concurrent-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  const result = await page.evaluate(async () => {
    const savedBill = await window.db.saveBillWithStockAndCollectionLog({
      bill: {
        customerName: 'Concurrent Customer',
        customerPhone: '',
        customerAddress: '',
        items: [{ name: 'Concurrent Product', qty: 1, price: 10000, amount: 10000 }],
        total: 10000,
        paymentMethod: 'credit',
        markAsCredit: true,
        payments: [],
        receivedAmount: 0,
        balanceAmount: 10000,
        changeAmount: 0,
        paymentStatus: 'due',
        billStatus: 'active',
        date: '2026-04-22',
        time: '10:00:00'
      },
      collectionLog: null,
      auditLog: {
        action: 'bill_create',
        entity: 'bill',
        details: { customerName: 'Concurrent Customer', total: 10000, receivedAmount: 0 }
      }
    });

    await Promise.all([
      window.db.collectBillPaymentAtomic({
        billId: savedBill.id,
        amount: 3000,
        method: 'cash',
        payment: { id: 'concurrent-pay-1', method: 'cash', amount: 3000 },
        auditLog: { action: 'collection_create', entity: 'bill', details: { amount: 3000, method: 'cash' } }
      }),
      window.db.collectBillPaymentAtomic({
        billId: savedBill.id,
        amount: 4000,
        method: 'bank',
        payment: { id: 'concurrent-pay-2', method: 'bank', amount: 4000 },
        auditLog: { action: 'collection_create', entity: 'bill', details: { amount: 4000, method: 'bank' } }
      })
    ]);

    const bill = await window.db.getBillById(savedBill.id);
    const logs = await window.db.getCollectionLogsByBill(savedBill.id);
    return {
      receivedAmount: bill.receivedAmount,
      balanceAmount: bill.balanceAmount,
      paymentStatus: bill.paymentStatus,
      paymentMethod: bill.paymentMethod,
      paymentCount: bill.payments.length,
      logCount: logs.length,
      logTotal: logs.reduce((sum, log) => sum + Number(log.amount || 0), 0)
    };
  });

  expect(result).toEqual({
    receivedAmount: 7000,
    balanceAmount: 3000,
    paymentStatus: 'due',
    paymentMethod: 'multiple',
    paymentCount: 2,
    logCount: 2,
    logTotal: 7000
  });

  await context.close();
  await browser.close();
});

test('cent rounding prevents tiny balance from showing due', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`rounding-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  const result = await page.evaluate(async () => {
    const rawTotal = 0.1 + 0.2;
    const rawReceived = 0.3;
    const savedBill = await window.db.saveBillWithStockAndCollectionLog({
      bill: {
        customerName: 'Rounding Customer',
        customerPhone: '',
        customerAddress: '',
        items: [{ name: 'Rounding Product', qty: 1, price: rawTotal, amount: rawTotal }],
        total: rawTotal,
        paymentMethod: 'cash',
        payments: [{ id: 'rounding-pay-1', method: 'cash', amount: rawReceived }],
        receivedAmount: rawReceived,
        balanceAmount: Math.max(0, rawTotal - rawReceived),
        changeAmount: 0,
        paymentStatus: rawTotal - rawReceived > 0 ? 'due' : 'paid',
        billStatus: 'active',
        date: '2026-04-22',
        time: '10:05:00'
      },
      collectionLog: null,
      auditLog: {
        action: 'bill_create',
        entity: 'bill',
        details: { customerName: 'Rounding Customer', total: rawTotal, receivedAmount: rawReceived }
      }
    });

    const bill = await window.db.getBillById(savedBill.id);
    window.share.currentBill = bill;
    return {
      normalizedBalance: bill.balanceAmount,
      summaryBalance: window.historyView.getBillSummary(bill).balance,
      stateLabel: window.historyView.getBillStateLabel(bill),
      shareText: window.share.formatBillText()
    };
  });

  expect(result.normalizedBalance).toBe(0);
  expect(result.summaryBalance).toBe(0);
  expect(result.stateLabel).toBe('Paid');
  expect(result.shareText).toContain('Balance: LKR 0');
  expect(result.shareText).toContain('Status: paid');

  await page.locator('#nav-collection').click();
  await expect(page.locator('#collection-list')).toContainText('No pending collections');

  await context.close();
  await browser.close();
});

test('concurrent bill creation assigns unique bill numbers and audit links', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`bill-number-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  const result = await page.evaluate(async () => {
    const makeBill = (customerName) => ({
      customerName,
      customerPhone: '',
      customerAddress: '',
      items: [{ name: 'Concurrent Bill Product', qty: 1, price: 100, amount: 100 }],
      total: 100,
      paymentMethod: 'cash',
      payments: [{ id: `${customerName}-payment`, method: 'cash', amount: 100 }],
      receivedAmount: 100,
      balanceAmount: 0,
      changeAmount: 0,
      paymentStatus: 'paid',
      billStatus: 'active',
      date: '2026-04-22',
      time: '10:10:00'
    });

    const [first, second] = await Promise.all([
      window.db.saveBillWithStockAndCollectionLog({
        bill: makeBill('Concurrent Bill Customer A'),
        collectionLog: {
          customerName: 'Concurrent Bill Customer A',
          amount: 100,
          method: 'cash',
          action: 'invoice_payment',
          beforeReceived: 0,
          afterReceived: 100
        },
        auditLog: {
          action: 'bill_create',
          entity: 'bill',
          details: { customerName: 'Concurrent Bill Customer A', total: 100, receivedAmount: 100 }
        }
      }),
      window.db.saveBillWithStockAndCollectionLog({
        bill: makeBill('Concurrent Bill Customer B'),
        collectionLog: {
          customerName: 'Concurrent Bill Customer B',
          amount: 100,
          method: 'cash',
          action: 'invoice_payment',
          beforeReceived: 0,
          afterReceived: 100
        },
        auditLog: {
          action: 'bill_create',
          entity: 'bill',
          details: { customerName: 'Concurrent Bill Customer B', total: 100, receivedAmount: 100 }
        }
      })
    ]);

    const billIds = [first.id, second.id].sort((a, b) => a - b);
    const bills = (await window.db.getBills()).filter((bill) => billIds.includes(bill.id));
    const auditLogs = (await window.db.getAuditLogs())
      .filter((log) => log.action === 'bill_create' && billIds.includes(log.entityId));
    const collectionLogs = (await window.db.getCollectionLogs())
      .filter((log) => billIds.includes(log.billId));

    return {
      billNumbers: bills.map((bill) => bill.billNumber).sort((a, b) => a - b),
      auditEntityIds: auditLogs.map((log) => log.entityId).sort((a, b) => a - b),
      auditBillNumbers: auditLogs.map((log) => log.details?.billNumber).sort((a, b) => a - b),
      collectionBillNumbers: collectionLogs.map((log) => log.billNumber).sort((a, b) => a - b),
      billIds
    };
  });

  expect(new Set(result.billNumbers).size).toBe(2);
  expect(result.auditEntityIds).toEqual(result.billIds);
  expect(result.auditBillNumbers).toEqual(result.billNumbers);
  expect(result.collectionBillNumbers).toEqual(result.billNumbers);

  await context.close();
  await browser.close();
});

test('history delete removes a bill', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const customerName = `Delete Test ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`delete-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForTimeout(1000); // Wait for navigation
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, 'Delete Test Product', 1200);
  await page.locator('#customer-name').fill(customerName);
  await page.locator('[id^="product-name-"]').first().fill('Delete Test Product');
  await page.locator('.bill-item input[placeholder="Price"]').first().fill('1200');
  await page.locator('#received-amount').fill('1200');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);
  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));

  await page.locator('#nav-history').click();
  await expect(page.locator('#history-page')).toHaveClass(/active/);
  await expect(page.locator('#history-list')).toContainText(customerName);

  let deleteDialogCount = 0;
  page.on('dialog', async (dialog) => {
    deleteDialogCount += 1;
    if (deleteDialogCount === 1) expect(dialog.message()).toContain('Delete bill');
    if (deleteDialogCount === 2) expect(dialog.message()).toContain('Return stock to inventory');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Del' }).first().click();

  await expect(page.locator('#history-list')).not.toContainText(customerName);

  await context.close();
  await browser.close();
});

test('inventory fields unlock with edit and lock after save', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const productName = `Inventory Lock ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`inventory-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await page.locator('#nav-inventory').click();
  await expect(page.locator('#inventory-page')).toHaveClass(/active/);

  await expect(page.locator('#inv-existing-product')).toBeDisabled();
  await expect(page.locator('#inv-new-name')).toBeDisabled();
  await expect(page.locator('[data-inventory-field]').first()).toBeDisabled();
  await expect(page.locator('#btn-inventory-save')).toBeHidden();

  await page.locator('#btn-inventory-edit').click();
  await expect(page.locator('#inv-existing-product')).toBeEnabled();
  await expect(page.locator('#inv-new-name')).toBeEnabled();
  await expect(page.locator('[data-inventory-field]').first()).toBeEnabled();
  await expect(page.locator('#btn-inventory-save')).toHaveClass(/hidden/);

  await page.locator('#inv-new-name').fill(productName);
  await expect(page.locator('#btn-inventory-save')).toBeVisible();
  await page.locator('#inv-new-stock').fill('8');
  await page.locator('#inv-new-billing-price').fill('900');
  await page.locator('#inv-new-invoice-price').fill('700');
  await page.locator('#btn-inventory-save').click();

  const productNameInput = page.locator(`input.inventory-name-input[value="${productName}"]`);
  await expect(productNameInput).toHaveCount(1);
  const productCard = productNameInput.locator('xpath=ancestor::div[contains(@class, "bill-item")]');
  await expect(page.locator('#inv-new-name')).toBeDisabled();
  await expect(page.locator('[data-inventory-field]').first()).toBeDisabled();
  await expect(page.locator('#btn-inventory-edit')).toBeVisible();
  await expect(page.locator('#btn-inventory-save')).toBeHidden();

  await page.locator('#btn-inventory-edit').click();
  await expect(page.locator('#btn-inventory-save')).toHaveClass(/hidden/);
  await page.locator('#inv-existing-product').selectOption({ label: productName });
  await expect(page.locator('#btn-inventory-save')).toBeVisible();
  await expect(page.locator('#inv-new-name')).toHaveValue(productName);
  await expect(page.locator('#inv-new-billing-price')).toHaveValue('900');
  await expect(page.locator('#inv-new-invoice-price')).toHaveValue('700');
  await page.locator('#inv-new-stock').fill('3');
  await page.locator('#inv-new-billing-price').fill('950');
  await page.locator('#inv-new-invoice-price').fill('750');
  await page.locator('#btn-inventory-save').click();

  await expect(productCard).toHaveCount(1);
  await expect(productCard.locator('[id^="inv-stock-"]')).toHaveValue('11');
  await expect(productCard.locator('[id^="inv-billing-price-"]')).toHaveValue('950');
  await expect(productCard.locator('[id^="inv-invoice-price-"]')).toHaveValue('750');
  await expect(page.locator('#inventory-list')).not.toContainText('Added Date & Time');

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-inventory-pdf').click();
  const reportPage = await popupPromise;
  await reportPage.waitForLoadState('domcontentloaded');
  await expect(reportPage.getByRole('button', { name: 'Download PDF' })).toBeVisible();
  await expect(reportPage.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(reportPage.getByRole('button', { name: 'Back to App' })).toBeVisible();
  await expect(reportPage.locator('#pdf-frame')).toBeVisible();
  await expect(reportPage.locator('.pdf-title')).toContainText('inventory-report');
  await reportPage.close();

  const renamedProduct = `${productName} Renamed`;
  await page.locator('#btn-inventory-edit').click();
  await productCard.locator('[id^="inv-name-"]').fill(renamedProduct);
  await page.locator('#inv-change-reason').fill('Rename product');
  await page.locator('#btn-inventory-save').click();
  const renamedProductInput = page.locator(`input.inventory-name-input[value="${renamedProduct}"]`);
  await expect(renamedProductInput).toHaveCount(1);
  await expect(page.locator(`input.inventory-name-input[value="${productName}"]`)).toHaveCount(0);

  await page.locator('#btn-inventory-edit').click();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Delete product');
    await dialog.accept();
  });
  await renamedProductInput.locator('xpath=ancestor::div[contains(@class, "bill-item")]').locator('.inventory-delete-btn').click();
  await expect(page.locator(`input.inventory-name-input[value="${renamedProduct}"]`)).toHaveCount(0);

  await context.close();
  await browser.close();
});

test('customers page adds and deletes a customer', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const customerName = `Manual Customer ${Date.now()}`;
  const newerCustomerName = `Recent Customer ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`customer-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForTimeout(1000); // Wait for navigation
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await page.locator('#nav-customers').click();
  await expect(page.locator('#customers-page')).toHaveClass(/active/);
  await page.locator('#btn-add-customer').click();
  await expect(page.locator('#customer-modal-title')).toHaveText('Add New Customer');

  await page.locator('#edit-customer-name').fill(customerName);
  await page.locator('#edit-customer-phone').fill('0711111111');
  await page.locator('#edit-customer-address').fill('Test Address');
  await page.locator('#btn-save-customer-edit').click();

  await expect(page.locator('#customers-list')).toContainText(customerName);
  await expect(page.locator('#customers-list')).toContainText('0711111111');

  await page.waitForTimeout(20);
  await page.locator('#btn-add-customer').click();
  await page.locator('#edit-customer-name').fill(newerCustomerName);
  await page.locator('#edit-customer-phone').fill('0722222222');
  await page.locator('#btn-save-customer-edit').click();

  await expect(page.locator('.customers-table tbody tr').first()).toContainText(newerCustomerName);
  await expect(page.locator('#customers-list')).toContainText('Added');

  await page.locator('.customers-table tbody tr').filter({ hasText: newerCustomerName }).locator('.customers-edit-btn').click();
  await expect(page.locator('#customer-modal-title')).toHaveText('Edit Customer');
  await expect(page.locator('#edit-customer-name')).toHaveValue(newerCustomerName);
  await page.getByRole('button', { name: 'Cancel' }).click();

  for (const name of [customerName, newerCustomerName]) {
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Delete customer');
      await dialog.accept();
    });
    await page.locator('.customers-table tbody tr').filter({ hasText: name }).locator('.customers-delete-btn').click();
    await expect(page.locator('#customers-list')).not.toContainText(name);
  }

  await context.close();
  await browser.close();
});

test('expenses page adds and deletes an expense on mobile', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const expenseName = `Packing Expense ${Date.now()}`;
  const olderExpenseName = `Fuel Expense ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`expense-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await page.locator('#nav-expenses').click();
  await expect(page.locator('#expenses-page')).toHaveClass(/active/);
  await expect(page.locator('#btn-add-expense')).toBeVisible();

  await page.locator('#expense-name').fill(expenseName);
  await page.locator('#expense-amount').fill('1250');
  await page.locator('#expense-date').fill('2026-04-20');
  await page.locator('#expense-note').fill('Carton boxes');
  await page.locator('#btn-add-expense').click();

  await expect(page.locator('#expenses-list')).toContainText(expenseName);
  await expect(page.locator('#expenses-list')).toContainText('Carton boxes');
  await expect(page.locator('#expenses-list')).toContainText('LKR 1,250');
  await expect(page.locator('#expenses-total')).toHaveText('LKR 1,250');

  await page.locator('#expense-name').fill(olderExpenseName);
  await page.locator('#expense-amount').fill('500');
  await page.locator('#expense-date').fill('2026-04-18');
  await page.locator('#btn-add-expense').click();

  await expect(page.locator('#expenses-list')).toContainText(olderExpenseName);
  await expect(page.locator('#expenses-total')).toHaveText('LKR 1,750');

  await page.locator('#expense-date-from').fill('2026-04-20');
  await expect(page.locator('#expenses-list')).toContainText(expenseName);
  await expect(page.locator('#expenses-list')).not.toContainText(olderExpenseName);
  await expect(page.locator('#expenses-total')).toHaveText('LKR 1,250');

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-print-expenses').click();
  const printPage = await popupPromise;
  await printPage.waitForLoadState('domcontentloaded');
  await expect(printPage.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(printPage.getByRole('button', { name: 'Back to App' })).toBeVisible();
  await expect(printPage.getByText(expenseName)).toBeVisible();
  await expect(printPage.getByText(olderExpenseName)).toHaveCount(0);
  await printPage.close();

  await page.locator('#btn-clear-expense-filter').click();
  await expect(page.locator('#expenses-list')).toContainText(expenseName);
  await expect(page.locator('#expenses-list')).toContainText(olderExpenseName);
  await expect(page.locator('#expenses-total')).toHaveText('LKR 1,750');

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Delete this expense');
    await dialog.accept();
  });
  await page.locator('.expense-card').filter({ hasText: expenseName }).locator('.expense-delete-btn').click();

  await expect(page.locator('#expenses-list')).not.toContainText(expenseName);
  await expect(page.locator('#expenses-total')).toHaveText('LKR 500');

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Delete this expense');
    await dialog.accept();
  });
  await page.locator('.expense-card').filter({ hasText: olderExpenseName }).locator('.expense-delete-btn').click();

  await expect(page.locator('#expenses-list')).not.toContainText(olderExpenseName);
  await expect(page.locator('#expenses-total')).toHaveText('LKR 0');

  await context.close();
  await browser.close();
});

test('billing can quick add missing product to inventory', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const productName = `Quick Add ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`quick-add-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    if (message.includes('Initial stock')) await dialog.accept('12');
    else if (message.includes('Selling price')) await dialog.accept('1600');
    else if (message.includes('Purchase price')) await dialog.accept('1100');
    else if (message.includes('Reorder level')) await dialog.accept('3');
    else await dialog.accept();
  });

  await page.locator('[id^="product-name-"]').first().fill(productName);
  await page.getByRole('button', { name: `Add "${productName}" to Inventory` }).click();
  await expect(page.locator('[id^="product-name-"]').first()).toHaveValue(productName);
  await expect(page.locator('.bill-item input[placeholder="Price"]').first()).toHaveValue('1600');

  await page.locator('#customer-name').fill('Quick Add Customer');
  await page.locator('#received-amount').fill('1600');
  await page.locator('#btn-generate-bill').click();
  await expect(page.locator('#share-modal')).toHaveClass(/active/);

  await page.locator('#share-modal').evaluate((el) => el.classList.remove('active'));
  await page.locator('#nav-inventory').click();
  await expect(page.locator('#inventory-page')).toHaveClass(/active/);
  const createdProductInput = page.locator(`input.inventory-name-input[value="${productName}"]`);
  await expect(createdProductInput).toHaveCount(1);
  await expect(createdProductInput.locator('xpath=ancestor::div[contains(@class, "bill-item")]').locator('[id^="inv-stock-"]')).toHaveValue('11');

  await context.close();
  await browser.close();
});

test('billing item name shows available products on focus', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  const productName = `Focus Product ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`focus-products-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await page.waitForSelector('#customer-name', { timeout: 5000 });
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  await seedInventoryProduct(page, productName, 1750, 20, 1200);
  await page.locator('[id^="product-name-"]').first().click();
  await expect(page.locator('[id^="product-autocomplete-"]').first()).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: productName })).toBeVisible();

  await page.getByRole('button', { name: productName }).click();
  await expect(page.locator('[id^="product-name-"]').first()).toHaveValue(productName);
  await expect(page.locator('.bill-item input[placeholder="Price"]').first()).toHaveValue('1750');
  await expect(page.locator('.product-stock-hint').first()).toHaveText('Available: 20 pcs | After this bill: 19 pcs');

  await page.locator('.bill-item .item-controls-grid input[type="number"]').first().fill('5');
  await expect(page.locator('.product-stock-hint').first()).toHaveText('Available: 20 pcs | After this bill: 15 pcs');

  await context.close();
  await browser.close();
});

test('backup import previews and keeps rollback snapshots', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block',
    acceptDownloads: true
  });
  const page = await context.newPage();
  const importedProduct = `Imported Product ${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-user').fill(`import-${Date.now()}`);
  await page.locator('#auth-pass').fill('1234');
  await page.locator('#btn-login').click();
  await expect(page.locator('#billing-page')).toHaveClass(/active/);

  const backupPayload = await page.evaluate(async (name) => {
    await window.db.addProduct('Before Import Product', 5, 500, 300, 2);
    const payload = await window.db.exportAllData();
    payload.data.products = [{
      id: 77,
      name,
      stock: 9,
      billingPrice: 900,
      invoicePrice: 600,
      reorderLevel: 2,
      inactive: false,
      created_at: Date.now(),
      updated_at: Date.now()
    }];
    payload.data.bills = [];
    payload.data.customers = [];
    payload.data.collectionLogs = [];
    payload.data.inventoryLogs = [];
    payload.data.expenses = [];
    payload.data.auditLogs = [];
    return JSON.stringify(payload);
  }, importedProduct);

  let confirmMessages = [];
  page.on('dialog', async (dialog) => {
    confirmMessages.push(dialog.message());
    await dialog.accept();
  });

  await page.locator('#nav-history').click();
  await expect(page.locator('#history-page')).toHaveClass(/active/);

  const fileInput = page.locator('#backup-import-file');
  const downloadPromise = page.waitForEvent('download');
  await fileInput.setInputFiles({
    name: 'import-preview.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupPayload)
  });
  await downloadPromise;

  await expect(page.locator('#history-list')).toBeVisible();
  await page.locator('#nav-inventory').click();
  await expect(page.locator('#inventory-page')).toHaveClass(/active/);
  await expect(page.locator(`input.inventory-name-input[value="${importedProduct}"]`)).toHaveCount(1);

  const rollbackCount = await page.evaluate(async () => {
    const snapshots = await window.db.getImportRollbacks();
    return snapshots.length;
  });
  expect(rollbackCount).toBe(1);
  expect(confirmMessages.some((message) => message.includes('Import Preview'))).toBeTruthy();
  expect(confirmMessages.some((message) => message.includes('pre-import backup download has started'))).toBeTruthy();

  await context.close();
  await browser.close();
});
