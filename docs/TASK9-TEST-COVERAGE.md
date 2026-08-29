# Task 9.1 test coverage

The repository test glob is `test/**/*.test.ts`. The Task 9.1 tests are additive; no test is skipped, made exclusive, or hidden behind a conditional discovery path.

| Requirement                                            | Evidence                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Typed EN/TR catalogs and fallback                      | `LocalizationService.test.ts`, `LocalizationCatalogCoverage.test.ts`                                        |
| `auto` locale resolution and explicit overrides        | `LocalizationService.test.ts`                                                                               |
| Rich/Safe runtime rendering                            | `LocalizationLiveUpdate.test.ts`                                                                            |
| Status bar and compact/detailed tooltip language       | `LocalizationLiveUpdate.test.ts`, existing `ProviderStatusBarTooltip.test.ts`                               |
| Notification/action language                           | `LocalizationLiveUpdate.test.ts`, `DashboardActionRunner` path                                              |
| Working/result action state preservation               | `LocalizationLiveUpdate.test.ts`                                                                            |
| Safe Dashboard change emitter                          | `LocalizationLiveUpdate.test.ts`, existing `SafeDashboard.test.ts`                                          |
| Manifest NLS catalogs and placeholder coverage         | `ManifestLocalization.test.ts`, updated `ManifestCommands.test.ts`, `ManifestConfigurationCoverage.test.ts` |
| Runtime hardcoded-string guardrails                    | `RuntimeStringCoverage.test.ts`                                                                             |
| Claude non-consumption boundary                        | `ClaudeUsageNonConsumption.test.ts` and existing OAuth transport/backoff tests                              |
| Settings language event and previous snapshot          | `SettingsServiceLanguage.test.ts`                                                                           |
| Settings schema, effective normalization and redaction | `SettingsSchema.test.ts`, `EffectiveSettings.test.ts`, `SettingsDiagnostics.test.ts`                        |
| Version 2 migration                                    | `SettingsMigrationV2.test.ts`                                                                               |

The pre-task report identified 64 files and 550 tests in the current checkout, while the requested historical baseline was 64 files and 555 tests. This checkout has no usable commit history, so the five missing historical tests cannot be reconstructed from Git; the 9.1 regression suite documents that limitation and adds dedicated behavior tests instead of masking it. The final verification records the actual discovered count and three consecutive full-suite results.
