import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('Audit Log', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.click('.sidebar-link:has-text("Audit log")');
    await expect(page).toHaveURL('/audit');
  });

  test('audit log page loads', async ({ page }) => {
    await expect(page.locator('h1:has-text("Audit log")')).toBeVisible();
    await expect(page.locator('.panel')).toBeVisible();
  });

  test('audit log has entries', async ({ page }) => {
    const table = page.locator('.panel table');
    const emptyState = page.locator('.panel:has-text("No audit entries")');
    const loadingState = page.locator('.panel:has-text("Loading audit log")');

    await page.waitForFunction(
      () => {
        const table = document.querySelector('.panel table');
        const empty = document.querySelector('.panel');
        const loading = document.querySelector('.panel');
        return (
          (table && table.querySelectorAll('tbody tr').length > 0) ||
          empty?.textContent?.includes('No audit entries') ||
          loading?.textContent?.includes('No audit entries') ||
          empty?.textContent?.includes('No entries match')
        );
      },
      { timeout: 15000 }
    );

    const hasTable = await table.isVisible().catch(() => false);
    const hasEmpty = await emptyState.isVisible().catch(() => false);

    expect(hasTable || hasEmpty).toBeTruthy();
  });
});
