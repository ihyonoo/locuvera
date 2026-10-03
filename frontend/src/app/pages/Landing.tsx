import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import '../../styles/landing.css';

const CONTACT_EMAIL = 'hyunu.choe@gmail.com';
const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  'Locuvera 도입 문의',
)}&body=${encodeURIComponent('병원명: \n담당자: \n연락처: \n문의 내용: \n')}`;

const FEATURES = [
  {
    image: '/images/features/blockchain.webp',
    title: '블록체인 무결성 검증',
    copy: '완료된 사용 이력은 프라이빗 Hyperledger Besu 체인에 앵커링되어, 이후 언제든 위변조 여부를 검증할 수 있습니다.',
    bullets: [
      '사용 이력을 블록체인에 기록',
      '기록뿐만 아니라 머클 증명을 활용한 완벽한 검증',
      '사후 대조로 조작 여부 즉시 확인',
      '감사·규정 대응 자료로 활용',
    ],
  },
  {
    image: '/images/features/auto.webp',
    title: 'NFC·RTLS 결합 자동 이력 생성',
    copy: '블록체인에 기록해도 입력값 자체가 틀리면 소용없습니다. NFC·RTLS 데이터를 결합해 사용 이력을 자동으로 생성함으로써 사람의 실수와 허위 입력을 원천 차단하고, 이력의 신뢰성을 한층 끌어올립니다.',
    bullets: [
      'NFC 체크아웃·반납과 RTLS 위치 데이터를 결합해 이력 자동 생성',
      '휴먼에러·허위 입력을 원천 차단',
      '정확한 원본 데이터로 블록체인 기록의 신뢰성 강화',
      '수기 기록 업무 부담 감소로 운영 효율 향상',
    ],
  },
  {
    image: '/images/features/rtls.webp',
    title: '실시간 위치 추적 (BLE 기반 RTLS)',
    copy: '의료진이 장비를 찾아 헤매는 시간을 없애 진료에만 집중하게 하고, 탐색에 낭비되던 인건비와 장비 유휴 비용을 절감합니다.',
    bullets: [
      '장비에 부착된 비콘을 구역별 RTLS 리더기가 감지',
      '신호 세기(RSSI) 기반 위치 판정',
      '의료진 대시보드에서 즉시 확인',
      '저전력 블루투스(BLE) 기반으로 저렴한 설치·유지보수 비용',
    ],
  },
];

const TRUST_ITEMS = [
  { label: 'Hyperledger Besu 기반 프라이빗 블록체인' },
  { label: 'BLE iBeacon 실시간 위치 추적' },
  { label: 'NFC 기반 장비 식별 및 장비 대여/반납' },
];

const STEPS = [
  { title: 'RTLS 리더 신호 수신', copy: '구역에 설치된 리더가 태그의 BLE 신호를 수집합니다.' },
  { title: '위치 판정', copy: '신호 세기를 분석해 장비의 현재 위치를 판정합니다.' },
  { title: 'NFC 체크아웃/반납', copy: '직원이 NFC로 태그해 대여·반납을 기록합니다.' },
  { title: '블록체인 앵커링', copy: '반납이 완료되면 사용 이력이 블록체인에 앵커링됩니다.' },
];

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.5, ease: 'easeOut' as const },
};

export default function Landing() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="landing">
      <header className={`landing__nav ${scrolled ? 'landing__nav--scrolled' : ''}`}>
        <div className="landing__container landing__nav-inner">
          {/* 랜딩이 이미 홈이라 이동할 곳이 없다 — 로고를 누르면 맨 위로 돌려보낸다. */}
          <button
            type="button"
            className="landing__brand"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            Locuvera
          </button>
          <nav className="landing__nav-links">
            <a className="landing__nav-link" href="#features">
              기능
            </a>
            <a className="landing__nav-link" href="#how-it-works">
              작동 방식
            </a>
            <a className="landing__nav-link" href="#contact">
              도입문의
            </a>
          </nav>
          <div className="landing__nav-actions">
            <Link to="/login" className="landing__nav-auth-link">
              로그인
            </Link>
            <Link to="/signup" className="landing__nav-auth-link">
              회원가입
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="landing__hero">
          <div className="landing__hero-bg" aria-hidden="true">
            <img src="/images/hero/monitor.jpg" alt="" />
          </div>
          <div className="landing__container landing__hero-inner">
            <h1 className="landing__headline">
              장비의 위치부터 사용 이력까지,
              <br className="landing__headline-break" />
              <em>위변조 없이</em> 증명합니다
            </h1>
            <p className="landing__subcopy">
              Locuvera는 BLE 기반 실시간 위치 추적과
              <br className="landing__subcopy-break" />
              프라이빗 블록체인 앵커링으로 의료 장비의 대여·반납 이력을
              <br className="landing__subcopy-break" />
              자동으로 기록하고 사후 검증까지 지원합니다.
            </p>
            <div className="landing__badges">
              {TRUST_ITEMS.map((item) => (
                <span className="landing__badge" key={item.label}>
                  {item.label}
                </span>
              ))}
            </div>
            <div className="landing__hero-auth">
              <Link to="/login" className="landing__hero-auth-link">
                로그인
              </Link>
              <span className="landing__hero-auth-divider" aria-hidden="true" />
              <Link to="/signup" className="landing__hero-auth-link">
                회원가입
              </Link>
            </div>
          </div>
        </section>

        <motion.section className="landing__section landing__section--alt" id="features" {...fadeUp}>
          <div className="landing__container">
            <div className="landing__section-head">
              <p className="landing__section-eyebrow">핵심 기능</p>
              <h2 className="landing__section-title">위변조 없이 증명하고, 정확하게 기록하며, 실시간으로 확인합니다</h2>
            </div>
            <div className="landing__features-stack">
              {FEATURES.map((feature) => (
                <div className="landing__feature-row" key={feature.title}>
                  <div className="landing__feature-media">
                    {feature.image ? (
                      <img src={feature.image} alt={feature.title} />
                    ) : (
                      <div className="landing__feature-media-placeholder" />
                    )}
                  </div>
                  <div className="landing__feature-body">
                    <h3 className="landing__feature-title">{feature.title}</h3>
                    <p className="landing__feature-copy">{feature.copy}</p>
                    <ul className="landing__feature-bullets">
                      {feature.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.section>

        <motion.section className="landing__section" id="how-it-works" {...fadeUp}>
          <div className="landing__container">
            <div className="landing__section-head">
              <p className="landing__section-eyebrow">작동 방식</p>
              <h2 className="landing__section-title">신호 수신부터 블록체인 앵커링까지</h2>
            </div>
            <div className="landing__steps">
              {STEPS.map((step, index) => (
                <div className="landing__step" key={step.title}>
                  <span className="landing__step-index">{index + 1}</span>
                  <h3 className="landing__step-title">{step.title}</h3>
                  <p className="landing__step-copy">{step.copy}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.section>

        <motion.section className="landing__section landing__section--alt" id="contact" {...fadeUp}>
          <div className="landing__container landing__contact-inner">
            <h2 className="landing__section-title landing__contact-title">
              장비 관리,
              <br />
              이제 투명하게 증명하세요
            </h2>
            <a className="landing__contact-cta" href={CONTACT_MAILTO}>
              문의하기
            </a>
            <a className="landing__contact-email" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
          </div>
        </motion.section>
      </main>

      <footer className="landing__footer">
        <div className="landing__container landing__footer-inner">
          <div>
            <div className="landing__footer-brand">Locuvera</div>
            <div className="landing__footer-copyright">© 2026 Locuvera</div>
          </div>
          <div className="landing__footer-links">
            <Link to="/login">로그인</Link>
            <Link to="/signup">회원가입</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
