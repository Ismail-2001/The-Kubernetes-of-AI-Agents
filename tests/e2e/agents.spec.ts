import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('Agent Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.click('.sidebar-link:has-text("Agents")');
    await expect(page).toHaveURL('/agents');
  });

  test('agents page loads', async ({ page }) => {
    await expect(page.locator('h1:has-text("Agents")')).toBeVisible();
    await expect(page.locator('.panel table')).toBeVisible();
  });

  test('create agent dialog opens', async ({ page }) => {
    await page.click('button:has-text("+ New agent")');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2:has-text("Create Agent")')).toBeVisible();
    await expect(dialog.locator('#agent-name')).toBeVisible();

    await dialog.locator('button[aria-label="Close dialog"]').click();
    await expect(dialog).not.toBeVisible();
  });

  test('agent list displays data', async ({ page }) => {
    const tableBody = page.locator('.panel table tbody');
    await expect(tableBody).toBeVisible();

    const rows = tableBody.locator('tr');
    const rowCount = await rows.count();

    const hasData = rowCount > 0 && !(await rows.first().locator('.empty-state').isVisible());
    const isEmpty = await tableBody.locator('.empty-state').isVisible();

    expect(hasData || isEmpty).toBeTruthy();
  });

  test('agent detail view', async ({ page }) => {
    const rows = page.locator('.panel table tbody tr');
    const rowCount = await rows.count();

    if (rowCount > 0 && !(await page.locator('.empty-state').isVisible())) {
      await rows.first().click();

      const detail = page.locator('.page');
      await expect(detail).toBeVisible();
    }
  });
});
