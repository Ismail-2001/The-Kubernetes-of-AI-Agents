import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL('/');
  });

  test('dashboard loads with metrics', async ({ page }) => {
    await expect(page.locator('.metric-grid')).toBeVisible();
    await expect(page.locator('.metric-card').first()).toBeVisible();
    await expect(page.locator('.metric-label').first()).toBeVisible();
  });

  test('dashboard shows namespace health', async ({ page }) => {
    const nsPanel = page.locator('.panel-header:has-text("Namespace health")');
    await expect(nsPanel).toBeVisible();
  });

  test('dashboard navigation works', async ({ page }) => {
    const navLinks = [
      { label: 'Agents', url: '/agents' },
      { label: 'Workflows', url: '/workflows' },
      { label: 'Policies', url: '/policies' },
      { label: 'Audit log', url: '/audit' },
    ];

    for (const link of navLinks) {
      await page.click(`.sidebar-link:has-text("${link.label}")`);
      await expect(page).toHaveURL(link.url);
      await expect(page.locator('.page h1')).toBeVisible();
    }
  });
});
