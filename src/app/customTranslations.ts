import type { PluralForms, TranslatedLanguage } from "./translations";

export const CUSTOM_TRANSLATIONS = {
  "Running": { "zh-Hans": "运行中", "zh-Hant": "執行中", "fa": "در حال اجرا", "ru": "Работает" },
  "Stopped": { "zh-Hans": "已停止", "zh-Hant": "已停止", "fa": "متوقف", "ru": "Остановлен" },
  "Throughput": { "zh-Hans": "吞吐", "zh-Hant": "吞吐", "fa": "توان عبور", "ru": "Пропускная способность" },
  "Total": { "zh-Hans": "总计", "zh-Hant": "總計", "fa": "مجموع", "ru": "Всего" },
  "Last 30 s": { "zh-Hans": "最近 30 秒", "zh-Hant": "最近 30 秒", "fa": "۳۰ ثانیه اخیر", "ru": "Последние 30 с" },
  "Now": { "zh-Hans": "现在", "zh-Hant": "現在", "fa": "اکنون", "ru": "Сейчас" },
  "Time": { "zh-Hans": "时间", "zh-Hant": "時間", "fa": "زمان", "ru": "Время" },
  "Proxy groups": { "zh-Hans": "代理组", "zh-Hant": "代理群組", "fa": "گروه‌های پروکسی", "ru": "Группы прокси" },
  "Manage groups": { "zh-Hans": "管理代理组", "zh-Hant": "管理代理群組", "fa": "مدیریت گروه‌ها", "ru": "Управление группами" },
  "Live connections": { "zh-Hans": "实时连接", "zh-Hant": "即時連線", "fa": "اتصال‌های زنده", "ru": "Текущие подключения" },
  "View all": { "zh-Hans": "查看全部", "zh-Hant": "檢視全部", "fa": "مشاهده همه", "ru": "Показать все" },
} as const satisfies Record<string, Record<TranslatedLanguage, string | PluralForms>>;
