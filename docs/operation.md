# 운영 기록

> 범용 배포 절차는 [deploy.md](deploy.md) 참고. 이 문서는 공개 가능한 수준으로 비식별화한 운영 상태와 배포 이력 기록이다.

## 현재 상태 (2026-07-04)

| 리소스 | 값/상태 |
|---|---|
| Worker | ✅ custom domain 연결됨 (workers.dev 라우트는 비활성화) |
| 계정 | ✅ Cloudflare 계정 연결됨 (계정명/ID 비공개) |
| D1 | ✅ 원격 DB 생성 및 `0000_init` 마이그레이션 적용 |
| R2 | ✅ vault mirror 버킷 생성 |
| R2 이벤트 알림 | ✅ object create/delete 이벤트가 index queue로 전달됨 |
| Queues | ✅ index queue 및 DLQ 생성 |
| Vectorize | ✅ chunk index 생성 (1024 dims, cosine) |
| Workers AI | ✅ `@cf/baai/bge-m3` 임베딩 동작 확인 (1024-dim) |
| Secrets | ✅ `API_TOKEN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` 설정됨 |
| Cloudflare Access (이메일 로그인) | ✅ Access 앱 + owner allow 정책 동작 확인 |
| remotely-save 동기화 | ✅ 첫 동기화 및 인덱싱 확인

## 타임라인

### 2026-07-02 (1차 — R2 없이 부분 배포)

- 모노레포 전체 구현 후 리소스 프로비저닝: D1 생성 + 원격 마이그레이션, Queues 2개,
  Vectorize 인덱스 생성.
- **R2 활성화 안 됨(code 10042)** + wrangler OAuth 토큰에 `r2`/`access` 스코프 부재
  → R2 바인딩을 뺀 `wrangler.no-r2.jsonc`로 우선 배포. R2 필요 경로는 안내 에러를
  반환하도록 가드(Proxy) 추가.
- `API_TOKEN` 시크릿 설정, 배포 검증: 무인증 401, Bearer 인증 OK, MCP `tools/list` OK.
- 로컬(wrangler dev)에서 capture → R2 → Queue → 인덱싱 → 한국어 FTS 검색 E2E 확인.

### 2026-07-02~03 (2차 — 풀 배포)

- 사용자가 대시보드에서 R2 활성화 + vault mirror 버킷 및 이벤트 알림 rule 생성.
- `wrangler.jsonc`(R2 바인딩 포함) 풀 구성으로 재배포. 임시 `wrangler.no-r2.jsonc` 제거.
- 프로덕션 E2E 검증:
  - `POST /api/capture` → R2 `inbox/` 파일 생성 ✅
  - R2 이벤트 → Queue → 인덱서 → D1 (약 20초 내) ✅
  - 한국어 FTS 검색(`한국어 색인` → snippet 매칭) ✅
  - 시맨틱 검색(BGE-M3 + Vectorize, `mode=semantic`) ✅
  - R2 오브젝트 삭제 → 삭제 이벤트 → soft-delete 반영 ✅
- 스모크 테스트 노트는 검증 후 삭제함.

### 2026-07-03 (커스텀 도메인)

- Workers custom domain 연결 (`wrangler.jsonc`의 `routes`,
  DNS/인증서 자동 발급). 이후 workers.dev 라우트는 자동 비활성화(404).

### 2026-07-03 (콘솔 UI)

- QuietFabric 디자인 시스템 기반 콘솔 UI를 `apps/worker/console/`에 추가하고
  Workers Static Assets로 서빙 (`assets.run_worker_first: ["/api/*", "/mcp"]`).
- 정적 UI는 공개(데이터 없음), API/MCP는 계속 인증 게이트. 401 시 UI가 토큰
  입력 다이얼로그를 띄우고 localStorage에 보관. Access를 붙이면 쿠키로 자동 인증.
- 기존 인라인 `src/ui.ts` 제거.

### 2026-07-12 (콘솔 UI 2차 — 브라우즈 뷰 + 라이트 테마)

- 첫 화면에 "recently updated" 브라우즈 뷰 추가 — 검색 전에도 최근 노트가 보임.
  `GET /api/pages`에 `sort=recent`(updated_at/indexed_at 역순), `path=<exact>` 파라미터 추가.
- Obsidian풍 미니멀 라이트 테마 추가(뉴트럴 화이트 서피스 + 바이올렛 액센트).
  다크(QuietFabric 표준)는 유지, `prefers-color-scheme` 기본값 + 헤더 토글로 전환,
  localStorage 저장. 테마 전환 시 transition 일괄 비활성 가드로 색 찢어짐 방지.
- 키보드 내비게이션: `⌘K`/`/` 검색 포커스, `↑/↓` 선택, `Enter` 열기, `Esc` 닫기/초기화.
- 리더 개선: 마크다운 테이블·체크리스트 렌더링, 모바일(≤900px) 풀스크린 오버레이,
  퍼센트 인코딩된 R2 키의 경로 표시 디코딩. 리스트는 태그 칩(클릭 시 태그 검색) 표시.
- Google Fonts `@import`(JetBrains Mono) 제거 — 외부 요청 없는 시스템 모노 스택으로 대체.
- 남아 있던 미사용 `src/ui.ts`(구 인라인 폴백 UI) 실제 삭제.
- 검증: 로컬 wrangler dev(D1/R2/Queue local)로 rebuild → 색인 → 브라우즈/검색/리더
  플로우를 Playwright로 21개 체크 통과. 정적 e2e 스모크 5개(테마·홈·단축키 포함) 통과.

## 운영 메모

- 토큰 분실 시 재발급: `openssl rand -hex 32 | wrangler secret put API_TOKEN` (apps/worker에서).
- 풀 리인덱스: `POST /api/index/rebuild` — R2 미러 기준 전체 재색인 (D1/Vectorize 유실 복구용).
- 에러 북: `GET /api/errors`, 증류 규칙: `GET /api/rules`.
- 정합성 검증: `flaregraph verify ~/Vault --api https://<worker-host>`
  (`CF_ACCESS_CLIENT_ID/SECRET` 또는 Bearer 환경변수 필요).
