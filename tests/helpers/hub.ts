import { expect, type Page } from '@playwright/test';

// The Community tab's three parts (2026-11-20, member-hub.js _feedHtml): Sessions (the next session, the Build-up plan,
// My interests, Coming up, the staff card), Challenges (the year, My month, the member's own challenge, Plan my Saturdays,
// the season challenges, the club's goal) and Club (the Community chat, Ask, mentorship, volunteers, Suggest a ride, the invitation). A card
// outside Sessions is reached through the switch first, as a member does.
export async function hubPart(page: Page, k: 'sess' | 'goals' | 'club') {
  const b = page.locator(`#hub-body .hub-sec[data-hub-sec="${k}"]`);
  await b.click();
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#hub-pane-${k}`)).toBeVisible();
}
