gsap.registerPlugin(ScrollTrigger);

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// 标题逐字拆分
$$(".write span").forEach((line) => {
  line.innerHTML = [...line.textContent].map((c) => `<span class="ch">${c}</span>`).join("");
});

// 干笔音量：多根笔毫随「音量」起伏，amp 为笔压
function brush(pill) {
  const bristles = $$(".brush i", pill);
  const state = { amp: 1 };
  gsap.ticker.add(() => {
    const t = performance.now() / 1000;
    bristles.forEach((b, i) => {
      const shape = Math.sin((i / (bristles.length - 1)) * Math.PI); // 中间浓、两端飞白
      const v = state.amp * shape * (0.45 + 0.55 * Math.abs(Math.sin(t * 5.3 + i * 1.7) * Math.sin(t * 2.1 + i)));
      b.style.height = `${2 + v * 16}px`;
    });
  });
  return state;
}

const heroBrush = brush($(".hero-pill"));
const stageBrush = brush($(".stage-pill"));

const mm = gsap.matchMedia();

mm.add("(prefers-reduced-motion: no-preference)", () => {
  // 首屏：标题由上而下写出
  gsap.from(".hero h1 .ch", {
    clipPath: "inset(0 0 100% 0)", filter: "blur(8px)", opacity: 0,
    duration: 0.9, ease: "power2.out", stagger: 0.07, delay: 0.2,
  });
  gsap.from(".hero .lead, .hero .muted, .hero .actions, .hero .fine, .flow", {
    opacity: 0, y: 14, filter: "blur(4px)", duration: 0.9, stagger: 0.12, delay: 0.9,
  });

  // 口述沿笔锋流入胶囊，另一侧流出整理后的正文
  const raw = $(".flow .raw textPath"), clean = $(".flow .clean textPath");
  const inLen = $("#p-in").getTotalLength(), outLen = $("#p-out").getTotalLength();
  const rawLen = $(".flow .raw").getComputedTextLength(), cleanLen = $(".flow .clean").getComputedTextLength();
  gsap.timeline({ repeat: -1, repeatDelay: 0.6, delay: 1.4 })
    .fromTo(raw, { attr: { startOffset: -rawLen } }, { attr: { startOffset: inLen }, duration: 5, ease: "none" })
    .fromTo(heroBrush, { amp: 0.15 }, { amp: 1, duration: 0.6 }, 0.4)
    .to(heroBrush, { amp: 0.15, duration: 0.6 }, 4.6)
    .fromTo(clean, { attr: { startOffset: -cleanLen } }, { attr: { startOffset: outLen * 0.32 }, duration: 2.2, ease: "power2.out" }, 4.4)
    .fromTo(".flow .tag", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4 }, 4.6)
    .to(clean, { attr: { startOffset: outLen }, duration: 2.6, ease: "power1.in" }, 7.4)
    .to(".flow .tag", { opacity: 0, duration: 0.4 }, 7.6);

  // 墨带：从中间向两侧洇开
  gsap.to(".band-ink", {
    clipPath: "inset(0 0% 0 0%)", ease: "none",
    scrollTrigger: { trigger: ".band", start: "top bottom", end: "center center", scrub: true },
  });

  // 章节标题由虚到实
  $$(".features h2, .features .eyebrow, .privacy h2, .scenes-head > *, .faq h2").forEach((el) => {
    gsap.from(el, { opacity: 0, y: 24, filter: "blur(6px)", duration: 1, scrollTrigger: { trigger: el, start: "top 85%" } });
  });

  // 功能格依次洇开，进入视口时播放小演示
  gsap.from(".cell", {
    opacity: 0, y: 30, filter: "blur(6px)", duration: 0.9, stagger: 0.15,
    scrollTrigger: { trigger: ".grid", start: "top 80%" },
  });
  $$(".demo").forEach((demo) => {
    ScrollTrigger.create({ trigger: demo, start: "top 75%", once: true, onEnter: () => setTimeout(() => demo.classList.add("on"), 500) });
  });
  const num = $(".nums em");
  ScrollTrigger.create({
    trigger: num, start: "top 75%", once: true,
    onEnter: () => gsap.timeline({ delay: 0.8 })
      .to(num, { opacity: 0, filter: "blur(6px)", duration: 0.4, onComplete: () => (num.textContent = num.dataset.to) })
      .to(num, { opacity: 1, filter: "blur(0px)", color: "#3E6A80", duration: 0.6 }),
  });

  // 隐私：细线自左画出，印章按下
  gsap.fromTo(".ledger li", { "--drawn": 0, opacity: 0 }, {
    "--drawn": 1, opacity: 1, duration: 0.9, stagger: 0.18, ease: "power2.out",
    scrollTrigger: { trigger: ".ledger", start: "top 80%" },
  });
  gsap.from(".stamp", {
    scale: 2.4, rotate: -24, opacity: 0, duration: 0.45, ease: "power4.in",
    scrollTrigger: { trigger: ".privacy-head", start: "top 70%" },
  });

  // 随处落笔：卡片按不同速度漂移
  $$(".card").forEach((card) => {
    const speed = Number(card.dataset.speed);
    gsap.fromTo(card, { y: 120 * speed }, {
      y: -50 * speed, ease: "none",
      scrollTrigger: { trigger: ".scenes", start: "top bottom", end: "bottom top", scrub: true },
    });
  });

  // 收尾：远山推近，标题写出
  gsap.fromTo(".cta-bg img", { scale: 1.25 }, {
    scale: 1, ease: "none",
    scrollTrigger: { trigger: ".cta", start: "top bottom", end: "bottom bottom", scrub: true },
  });
  gsap.from(".cta h2 .ch", {
    clipPath: "inset(0 0 100% 0)", filter: "blur(8px)", opacity: 0, duration: 0.9, stagger: 0.1,
    scrollTrigger: { trigger: ".cta", start: "top 40%" },
  });
  gsap.from(".cta .kai, .cta .actions", {
    opacity: 0, y: 14, duration: 0.8, stagger: 0.15, delay: 0.6,
    scrollTrigger: { trigger: ".cta", start: "top 40%" },
  });

  // 页脚字标自下而上露出
  gsap.fromTo(".wordmark span", { yPercent: 70 }, {
    yPercent: 0, ease: "none",
    scrollTrigger: { trigger: "footer", start: "top bottom", end: "bottom bottom", scrub: true },
  });
});

// 墨带样例句相向平移（无缝循环）
mm.add("(prefers-reduced-motion: no-preference)", () => {
  $$(".marquee").forEach((m) => {
    const row = $(".row", m);
    row.innerHTML += row.innerHTML;
    const rev = m.classList.contains("rev");
    gsap.fromTo(row, { xPercent: rev ? -50 : 0 }, { xPercent: rev ? 0 : -50, duration: 60, ease: "none", repeat: -1 });
  });
});

// 三步演示：滚动驱动浮层上浮 → 干笔音量 → 正文逐字落入
const sentence = "下周三下午 3 点开会，把发布节奏和验收标准一起过一遍。";
const steps = $$(".steps li"), caps = $$(".cap");
const pill = $(".stage-pill"), timer = $(".stage-pill .t"), typed = $(".typed .txt");
const strokePath = $(".long-stroke path");
const strokeLen = strokePath.getTotalLength();
strokePath.style.strokeDasharray = strokeLen;

function renderHow(p) {
  const step = Math.min(2, Math.floor(p * 3));
  steps.forEach((s, i) => s.classList.toggle("on", i === step));
  caps.forEach((c, i) => c.classList.toggle("on", i === step));
  const show = gsap.utils.clamp(0, 1, p / 0.1);
  pill.style.opacity = show;
  pill.style.transform = `translate(-50%, ${20 * (1 - show)}px)`;
  const speak = gsap.utils.clamp(0, 1, (p - 1 / 3) / (1 / 3));
  timer.textContent = `0:0${Math.round(speak * 6)}`;
  stageBrush.amp = step === 1 ? 1 : 0.12;
  const write = gsap.utils.clamp(0, 1, (p - 2 / 3) / 0.25);
  typed.textContent = sentence.slice(0, Math.round(write * sentence.length));
  pill.classList.toggle("done", write >= 1);
  strokePath.style.strokeDashoffset = strokeLen * (1 - p);
}

mm.add({
  desktop: "(min-width: 861px) and (prefers-reduced-motion: no-preference)",
  mobile: "(max-width: 860px) and (prefers-reduced-motion: no-preference)",
}, (ctx) => {
  const { desktop } = ctx.conditions;
  ScrollTrigger.create({
    trigger: ".how",
    start: desktop ? "top top" : "top 70%",
    end: desktop ? "+=2400" : "bottom 30%",
    pin: desktop,
    scrub: true,
    onUpdate: (self) => renderHow(self.progress),
  });
  renderHow(0);
});

// 减弱动态效果：直接呈现终态
mm.add("(prefers-reduced-motion: reduce)", () => {
  renderHow(1);
  heroBrush.amp = stageBrush.amp = 0.3;
  $$(".demo").forEach((d) => d.classList.add("on"));
  const num = $(".nums em");
  num.textContent = num.dataset.to;
  $(".flow .tag").style.opacity = 1;
  $(".flow .raw textPath").setAttribute("startOffset", "8%");
  $(".flow .clean textPath").setAttribute("startOffset", "18%");
});
