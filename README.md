# 📱 PDF 뷰어 (PWA)

스마트폰 브라우저에서 바로 사용하는 가벼운 PDF 뷰어입니다. 설치 없이 열리고, "홈 화면에 추가"로 앱처럼 쓸 수 있으며 오프라인에서도 동작합니다.

## ✨ 기능
- **PDF 열기** — 파일 선택 또는 드래그 앤 드롭
- **연속 스크롤 보기** — 전체 페이지 세로 스크롤
- **페이지 넘김** — 좌우 스와이프 · 페이지 번호 직접 입력 · 키보드 방향키
- **확대/축소** — 버튼 · 두 손가락 핀치 줌 · 화면 너비 자동 맞춤
- **목차** — PDF 내장 목차(북마크)로 빠른 이동
- **검색** — 문서 내 텍스트 검색, 결과 하이라이트 및 이전/다음 이동
- **PWA** — 홈 화면 설치 · 오프라인 캐시

## 🛠 기술 스택
- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF 렌더링
- 바닐라 JavaScript (프레임워크 없음)
- Service Worker + Web App Manifest (PWA)

## 🚀 로컬 실행
```bash
python -m http.server 8777
# 브라우저에서 http://127.0.0.1:8777 접속
```

## 📂 구조
```
├─ index.html        # 뷰어 화면
├─ css/style.css     # 모바일 우선 UI
├─ js/app.js         # 뷰어 로직
├─ vendor/           # PDF.js 라이브러리
├─ manifest.json     # PWA 설정
├─ sw.js             # 서비스 워커
└─ icons/            # 앱 아이콘
```

## 📄 라이선스
PDF.js는 Apache License 2.0을 따릅니다.
