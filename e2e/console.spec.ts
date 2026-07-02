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
});
