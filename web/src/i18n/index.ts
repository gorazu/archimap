// Interface languages. The one picked is remembered with the other settings
// ("archimap:language"); before any pick, the browser's language, English
// when it is neither. Zone and map names stay as the game (French) has them.
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./en";
import fr from "./fr";

export const LANGUAGES = ["fr", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_KEY = "archimap:language";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { fr: { translation: fr }, en: { translation: en } },
    supportedLngs: LANGUAGES,
    // "fr-CA" is French.
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    fallbackLng: "en",
    detection: { order: ["localStorage", "navigator"], lookupLocalStorage: LANGUAGE_KEY, caches: ["localStorage"] },
    interpolation: { escapeValue: false }, // React escapes already.
    returnNull: false,
  });

const setDocumentLanguage = (lng: string) => document.documentElement.setAttribute("lang", lng);
setDocumentLanguage(i18n.resolvedLanguage ?? "en");
i18n.on("languageChanged", setDocumentLanguage);

/** The language in use, one of LANGUAGES. */
export function currentLanguage(): Language {
  return i18n.resolvedLanguage === "fr" ? "fr" : "en";
}

export default i18n;
