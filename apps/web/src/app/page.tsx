import Link from "next/link";

export const metadata = {
  title: "kmmzavod — AI Video Factory",
  description: "Создавайте профессиональные видео с помощью искусственного интеллекта. Автоматизированный конвейер генерации контента.",
};

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-surface-0 relative overflow-hidden">
      {/* Ambient glow effects */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-brand-500/[0.07] blur-[120px]" />
        <div className="absolute -bottom-60 -right-40 w-[500px] h-[500px] rounded-full bg-brand-400/[0.05] blur-[100px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-full bg-brand-500/[0.03] blur-[80px]" />
      </div>

      {/* Grid pattern overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: "linear-gradient(hsl(var(--text-primary)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--text-primary)) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Navigation */}
      <nav className="relative z-10 flex items-center justify-between px-6 lg:px-12 h-16">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden>
              <path d="M6 7l4 4-4 4M11 15h5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="font-semibold tracking-tight text-text-primary">kmmzavod</span>
          <span className="text-xs font-medium text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded-md ml-1">AI</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5"
          >
            Войти
          </Link>
          <Link
            href="/register"
            className="text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 transition-colors px-4 py-1.5 rounded-lg shadow-sm"
          >
            Регистрация
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative z-10 flex flex-col items-center text-center px-6 pt-20 pb-24 lg:pt-32 lg:pb-36">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-brand-500/20 bg-brand-500/5 mb-8">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-500"></span>
          </span>
          <span className="text-xs font-medium text-brand-400">AI-powered платформа</span>
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-text-primary max-w-3xl leading-[1.1] tracking-tight">
          Видео-контент на
          <span className="bg-gradient-to-r from-brand-400 via-brand-500 to-brand-600 bg-clip-text text-transparent"> автопилоте</span>
        </h1>

        <p className="mt-6 text-lg text-text-secondary max-w-xl leading-relaxed">
          Создавайте профессиональные видеоролики за минуты, а не часы.
          Аватары, голоса, субтитры, монтаж — всё автоматически.
        </p>

        {/* CTA Buttons */}
        <div className="mt-10 flex flex-col sm:flex-row items-center gap-3">
          <Link
            href="/register"
            className="group relative inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-brand-500 text-white font-semibold text-sm hover:bg-brand-600 transition-all shadow-brand-glow hover:shadow-brand-glow-sm"
          >
            Выбрать тариф
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:translate-x-0.5 transition-transform" aria-hidden>
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-border text-text-primary font-semibold text-sm hover:bg-surface-2 transition-all"
          >
            Войти в аккаунт
          </Link>
        </div>

        {/* Stats */}
        <div className="mt-16 grid grid-cols-3 gap-8 sm:gap-16">
          <div>
            <p className="text-2xl sm:text-3xl font-bold text-text-primary">AI</p>
            <p className="text-xs sm:text-sm text-text-tertiary mt-1">Генерация</p>
          </div>
          <div>
            <p className="text-2xl sm:text-3xl font-bold text-text-primary">4K</p>
            <p className="text-xs sm:text-sm text-text-tertiary mt-1">Качество</p>
          </div>
          <div>
            <p className="text-2xl sm:text-3xl font-bold text-text-primary">24/7</p>
            <p className="text-xs sm:text-sm text-text-tertiary mt-1">Автоматизация</p>
          </div>
        </div>

        {/* Preview mockup */}
        <div className="mt-20 w-full max-w-4xl mx-auto">
          <div className="rounded-2xl border border-border bg-surface-1/50 backdrop-blur-sm shadow-elevation-3 overflow-hidden">
            {/* Window chrome */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-1">
              <span className="w-3 h-3 rounded-full bg-red-400/60" />
              <span className="w-3 h-3 rounded-full bg-yellow-400/60" />
              <span className="w-3 h-3 rounded-full bg-green-400/60" />
              <span className="flex-1 text-center text-xs text-text-tertiary">kmmzavod — AI Video Factory</span>
            </div>
            {/* Dashboard preview */}
            <div className="p-6 bg-surface-0">
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { label: "Видео создано", val: "0" },
                  { label: "Активные задачи", val: "0" },
                  { label: "Тариф", val: "Pro" },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-border bg-surface-1 p-3">
                    <p className="text-lg font-bold text-text-primary">{s.val}</p>
                    <p className="text-xs text-text-tertiary">{s.label}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border bg-surface-1 p-4 h-28 flex items-center justify-center">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="M10 9l5 3-5 3V9z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-text-primary">Готовы создать первое видео?</p>
                    <p className="text-xs text-text-tertiary">Выберите тариф и начните создавать</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Features */}
      <section className="relative z-10 px-6 lg:px-12 pb-24">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-text-primary text-center mb-12">
            Всё для создания видео
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              {
                icon: "M15 10l5 3-5 3V10z M4 5h13a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z",
                title: "AI-аватары",
                desc: "Реалистичные цифровые ведущие. Выберите из библиотеки или создайте своего.",
              },
              {
                icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
                title: "Автоматический монтаж",
                desc: "Переходы, субтитры, музыка — система собирает всё сама по вашему промпту.",
              },
              {
                icon: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
                title: "Быстрая генерация",
                desc: "Конвейерная обработка через BullMQ. Видео готовы за минуты, а не часы.",
              },
              {
                icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
                title: "Мульти-тенантность",
                desc: "Изолированные рабочие пространства для команд с разграничением доступа.",
              },
              {
                icon: "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z",
                title: "API-first",
                desc: "Полное REST API для интеграции. Webhooks для отслеживания статуса.",
              },
              {
                icon: "M12 3v18M3 12h18",
                title: "Гибкие тарифы",
                desc: "Выберите план под ваши задачи — от стартового до корпоративного.",
              },
            ].map((feature) => (
              <div key={feature.title} className="rounded-xl border border-border bg-surface-1/50 p-5 hover:bg-surface-1 hover:border-border/60 transition-all group">
                <div className="w-10 h-10 rounded-lg bg-brand-500/10 flex items-center justify-center mb-4 group-hover:bg-brand-500/15 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d={feature.icon} />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-text-primary mb-1.5">{feature.title}</h3>
                <p className="text-xs text-text-tertiary leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA bottom */}
      <section className="relative z-10 px-6 lg:px-12 pb-24">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-text-primary mb-4">
            Готовы попробовать?
          </h2>
          <p className="text-text-secondary mb-8">
            Создайте аккаунт за 30 секунд и выберите подходящий тариф.
          </p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-all shadow-brand-glow"
          >
            Создать аккаунт
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border py-6 px-6 lg:px-12">
        <div className="flex items-center justify-between text-xs text-text-tertiary">
          <span>&copy; {new Date().getFullYear()} kmmzavod. AI Video Factory.</span>
        </div>
      </footer>
    </div>
  );
}
