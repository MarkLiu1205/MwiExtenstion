import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.vue", import.meta.url), "utf8");

describe("App header support links", () => {
    it("links to the enhancement simulator and hides combat tools through route metadata", () => {
        expect(appSource).toContain('to="/enhancement"');
        expect(appSource).toContain("common:menu.enhancement");
        expect(appSource).toContain('v-if="showCombatToolbar"');
        expect(appSource).toContain("route.meta?.showCombatToolbar !== false");
    });

    it("links to the skilling planner", () => {
        expect(appSource).toContain('to="/skilling"');
        expect(appSource).toContain("common:menu.skilling");
    });

    it("renders GitHub and feedback entry points in the header", () => {
        expect(appSource).toContain("https://github.com/azhu949/MWICombatSimulator");
        expect(appSource).not.toContain("__REPOSITORY_URL__");
        expect(appSource).toContain('t("common:vue.app.feedback", "Feedback")');
        expect(appSource).toContain('t("common:vue.app.feedbackGitHubAriaLabel", "GitHub Repository")');
    });

    it("renders feedback modal contact details", () => {
        expect(appSource).toContain("993488247");
        expect(appSource).toContain("mailto:596846069@qq.com");
        expect(appSource).toContain("copyFeedbackContact");
        expect(appSource).toContain('t("common:vue.app.feedbackHint", "Use the following channels for feedback, bug reports, or suggestions.")');
        expect(appSource).toContain('t("common:vue.app.feedbackQqLabel", "QQ Group")');
        expect(appSource).toContain('t("common:vue.app.feedbackEmailLabel", "QQ Email")');
    });

    it("renders the theme toggle as an icon button with accessible labels", () => {
        expect(appSource).toContain('class="action-button-muted header-icon-button"');
        expect(appSource).toContain(':aria-label="themeToggleAriaLabel"');
        expect(appSource).toContain(':title="themeToggleAriaLabel"');
        expect(appSource).toContain('t("common:vue.app.switchToLightTheme", "Switch to light mode")');
        expect(appSource).toContain('t("common:vue.app.switchToDarkTheme", "Switch to dark mode")');
        expect(appSource).not.toContain('{{ t("common:controls.darkMode", "Dark Mode") }}: {{ themeLabel }}');
    });

    it("does not render a language switcher (site is locked to Traditional Chinese)", () => {
        expect(appSource).not.toContain("languageToggleLabel");
        expect(appSource).not.toContain("languageToggleAriaLabel");
        expect(appSource).not.toContain("switchLanguage");
    });

    it("renders a baseline reminder modal before running topbar baseline", () => {
        expect(appSource).toContain(':open="baselineReminderModalOpen"');
        expect(appSource).toContain(`t('common:queue.baselineReminderTitle', 'Baseline Rounds Reminder')`);
        expect(appSource).toContain('t("common:queue.baselineRecommendationHint"');
        expect(appSource).toContain('t("common:queue.baselineReminderAggregationHint"');
        expect(appSource).toContain('data-baseline-reminder-acknowledge');
        expect(appSource).toContain('@click="acknowledgeBaselineReminderAndRun"');
        expect(appSource).toContain('@click="openBaselineReminderSettings"');
    });

    it("gates the topbar baseline action behind the reminder until it is dismissed", () => {
        expect(appSource).toContain("const baselineReminderDismissed = ref(isBaselineReminderDismissed());");
        expect(appSource).toContain("if (!baselineReminderDismissed.value) {");
        expect(appSource).toContain("baselineReminderModalOpen.value = true;");
        expect(appSource).toContain("baselineReminderDismissed.value = true;");
        expect(appSource).toContain("dismissBaselineReminder();");
        expect(appSource).toContain("await runTopbarBaselineSimulation();");
    });
});
