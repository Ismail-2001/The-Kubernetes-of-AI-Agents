import { type Page, type BrowserContext } from '@playwright/test';

export const TEST_USER = {
  email: 'source@egaop.io',
  password: 'SourceBuild123!',
} as const;

export async function login(page: Page, email = TEST_USER.email, password = TEST_USER.password) {
  await page.goto('/login');
  await page.waitForSelector('#email');

  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');

  await page.waitForURL('**/');
}

export async function getAuthState(context: BrowserContext) {
  const cookies = await context.cookies();
  const storage = await context.storageState();
  return { cookies, storage };
}
