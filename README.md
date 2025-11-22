# backend

## KFTC 연결 엔드포인트

### 1) 인증 URL 생성
`GET /bank/auth-url`
```json
{
  "authUrl": "https://testapi.openbanking.or.kr/oauth/2.0/authorize?response_type=code&client_id=...&redirect_uri=...&scope=login%20transfer&state=...&auth_type=0",
  "state": "32자리난수",
  "scope": "login transfer"
}
```
- 프런트는 `authUrl`을 WebView 등에 로드. `state`는 콜백 시 검증에 사용되므로 프런트에서도 보관.

### 2) 콜백 (kftcAuthCode 획득)
`GET /bank/auth/callback` (금융결제원에 등록된 `redirect_uri`로 이 URL을 등록)
응답 예:
```json
{
  "kftcAuthCode": "code값",
  "scope": "login transfer",
  "state": "요청 시 받은 state"
}
```
- `state`가 서버에 저장된 값과 다르거나 만료되면 400을 반환.
- 콜백에서 받은 `kftcAuthCode`를 다음 단계 `/bank/connect`에 전달.

### 환경변수
```
KFTC_BASE_URL=https://testapi.openbanking.or.kr   # 생략 시 기본값
KFTC_CLIENT_ID=발급받은_클라이언트_ID
KFTC_CLIENT_SECRET=발급받은_클라이언트_시크릿
KFTC_REDIRECT_URI=http://myapp.com/callback      # 금융결제원에 등록한 redirect_uri와 반드시 동일
```

### 요청
`POST /bank/connect`
```json
{
  "kftcAuthCode": "앱에서 가로챈 code",
  "scope": "login transfer"
}
```

### 응답 예시
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "tokenType": "Bearer",
  "expiresIn": 7776000,
  "scope": "login transfer",
  "userSeqNo": "1100123456",
  "raw": { "access_token": "...", "user_seq_no": "...", "scope": "login transfer" }
}
```
