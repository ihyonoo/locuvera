import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  // 빌드 산출물·의존성·가상환경 디렉터리는 검사 대상에서 제외한다.
  // docs/도 제외한다 — 저작권 등록용 소스 사본이 들어 있고, 그 사본은 고쳐서는 안 된다.
  { ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/.venv/**', '**/.claude/**', 'docs/**'] },
  // 문법 오류·미사용 변수 등 기본 규칙(js/recommended)을 모든 JS/TS 파일에 적용한다.
  { files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'], plugins: { js }, extends: ['js/recommended'] },
  // TypeScript 전용 규칙을 추가로 적용한다.
  tseslint.configs.recommended,
  {
    // frontend/는 브라우저에서 실행되므로 브라우저 전역(window 등)을 쓴다.
    files: ['frontend/**/*.{js,jsx,ts,tsx}'],
    languageOptions: { globals: globals.browser },
    // React 기본 규칙, hooks 규칙(react-hooks v7 recommended), 새 JSX 런타임(import React 불필요)을 적용한다.
    extends: [
      pluginReact.configs.flat.recommended,
      pluginReact.configs.flat['jsx-runtime'],
      pluginReactHooks.configs.flat.recommended,
    ],
    // React 버전을 자동 감지해 "React version not specified" 경고를 없앤다.
    settings: { react: { version: 'detect' } },
  },
  {
    // blockchain/besu/의 Node.js 스크립트는 브라우저가 아니라 Node 전역(process 등)을 쓴다.
    files: ['blockchain/besu/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  // Prettier와 충돌하는 스타일 규칙을 꺼서 포맷팅은 Prettier에게 전담시킨다.
  prettierConfig,
]);
