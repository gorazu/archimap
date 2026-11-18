import type fr from "./fr";

// Translation keys are checked at build time against the French texts.
declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof fr };
  }
}
