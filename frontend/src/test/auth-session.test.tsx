import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { storePrivateKeyForUser } from '../api/client';

const api = vi.hoisted(() => ({getSession:vi.fn(),login:vi.fn()}));
vi.mock('../api',() => ({api}));
vi.mock('../utils/signature',() => ({publicKeyFromPrivateKey:()=>'public',privateKeyMatchesPublicKey:()=>true,
  generateSigningKeyPair:vi.fn(),signPayloadWithPrivateJwk:vi.fn()}));
function Identity() {
  const auth=useAuth();
  return <><span>{auth.loading ? '加载中' : auth.user?.username ?? '未登录'}</span>
    <button onClick={() => void auth.login('alice','password')}>登录</button></>;
}
beforeEach(() => {localStorage.clear();vi.resetAllMocks();});
afterEach(() => localStorage.clear());

it('returns an already-open page to signed-out state when its session has been revoked', async () => {
  api.getSession.mockResolvedValue({user:{id:'member',username:'受邀者',founder:false},csrf:'csrf'});
  localStorage.setItem('token','session');
  render(<AuthProvider><Identity /></AuthProvider>);
  await screen.findByText('受邀者');
  act(() => {window.dispatchEvent(new Event('gonglun:session-expired'));});
  expect(screen.getByText('未登录')).toBeInTheDocument();
  expect(localStorage.getItem('user')).toBeNull();
  expect(localStorage.getItem('token')).toBeNull();
});

it('ignores a bootstrap response that arrives after the session has been revoked', async () => {
  let finish!: (session: unknown) => void;
  api.getSession.mockReturnValue(new Promise(resolve => {finish = resolve;}));
  render(<AuthProvider><Identity /></AuthProvider>);
  act(() => {window.dispatchEvent(new Event('gonglun:session-expired'));});
  await act(async () => {finish({user:{id:'member',username:'受邀者'},csrf:'revoked-csrf'});});
  expect(screen.getByText('未登录')).toBeInTheDocument();
  expect(localStorage.getItem('user')).toBeNull();
});

it.each(['success','error'])('keeps a fresh login when the bootstrap finishes late with %s', async outcome => {
  let finish!: (session: unknown) => void, fail!: (error: Error) => void;
  api.getSession.mockReturnValue(new Promise((resolve,reject) => {finish=resolve;fail=reject;}));
  api.login.mockResolvedValue({token:'session',user:{id:'member',username:'alice',publicKey:'public'}});
  storePrivateKeyForUser('alice',{});
  render(<AuthProvider><Identity /></AuthProvider>);
  fireEvent.click(screen.getByRole('button',{name:'登录'}));
  await screen.findByText('alice');
  await act(async () => {
    if (outcome === 'success') finish({user:{id:'old-member',username:'旧用户'},csrf:'old-csrf'});
    else fail(new DOMException('会话已变更','AbortError'));
  });
  expect(screen.getByText('alice')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('user')!).id).toBe('member');
});
