import { expect, test } from '@playwright/test';

test.describe('console UI', () => {
  test('renders search shell', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('FlareGraph');
    await expect(page.locator('header .name')).toHaveText('FlareGraph');
    await expect(page.locator('#q')).toBeVisible();
    await expect(page.locator('#modes button')).toHaveCount(4);
    await expect(page.locator('#modes button.on')).toHaveText('Hybrid');
  });

  test('mode switch and token dialog handling', async ({ page }) => {
    await page.goto('/');
    await page.locator('#modes button[data-mode="semantic"]').click();
    await expect(page.locator('#modes button.on')).toHaveText('Semantic');

    // With no API behind the static server, health probing must not break the page;
    // the auth dialog (if opened by a 401) stays dismissible.
    const dlg = page.locator('#tokendlg');
    if (await dlg.evaluate((d) => (d as HTMLDialogElement).open)) {
      await page.locator('#token-cancel').click();
    }
    await expect(page.locator('#q')).toBeEnabled();
  });

  test('home view degrades gracefully without an API', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#listlabel')).toHaveText(/recently updated/i);
    // static server has no /api — the browse list must show a calm empty state
    await expect(page.locator('#results .empty')).toBeVisible();
  });

  test('theme toggle flips and persists', async ({ page }) => {
    await page.goto('/');
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const initial = await theme();
    await page.locator('#themebtn').click();
    const flipped = await theme();
    expect(flipped).not.toBe(initial);
    await page.reload();
    expect(await theme()).toBe(flipped);
  });

  test('slash shortcut focuses search', async ({ page }) => {
    await page.goto('/');
    await page.locator('header .name').click(); // move focus away from the autofocused input
    await expect(page.locator('#q')).not.toBeFocused();
    await page.keyboard.press('/');
    await expect(page.locator('#q')).toBeFocused();
    await expect(page.locator('#q')).toHaveValue('');
  });
});
