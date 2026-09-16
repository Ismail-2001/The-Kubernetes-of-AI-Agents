import { test, expect } from '@playwright/test';
import { login, TEST_USER } from './helpers/auth';

test.describe('Authentication', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login');

    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('text=Sign in')).toBeVisible();
  });

  test('login with valid credentials redirects to dashboard', async ({ page }) => {
    await login(page, TEST_USER.email, TEST_USER.password);

    await expect(page).toHaveURL('/');
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible();
  });

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login');

    await page.fill('#email', TEST_USER.email);
    await page.fill('#password', 'WrongPassword123!');
    await page.click('button[type="submit"]');

    await expect(page.locator('.login-error')).toBeVisible({ timeout: 10000 });
  });

  test('logout clears session', async ({ page }) => {
    await login(page, TEST_USER.email, TEST_USER.password);
    await expect(page).toHaveURL('/');

    await page.click('.sidebar-logout');

    await expect(page).toHaveURL('/login');
  });
});
