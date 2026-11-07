import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AccessManagementModal from '../components/AccessManagementModal';

const api = vi.hoisted(() => ({createAdminInvite:vi.fn(),getAdminAccounts:vi.fn(),getAdminInvites:vi.fn(),revokeAdminInvite:vi.fn(),setAdminAccountDisabled:vi.fn()}));
vi.mock('../api/client',() => api);
const invite = {id:'invite-1',hint:'…123456',createdAt:'2026-11-07T00:00:00.000Z',expiresAt:'2026-11-14T00:00:00.000Z',usedAt:null,usedBy:null,usedByName:null,revokedAt:null,status:'available'};
beforeEach(() => {
  vi.resetAllMocks();
  api.getAdminInvites.mockResolvedValue({items:[],nextCursor:null});
  api.getAdminAccounts.mockResolvedValue({items:[
    {id:'admin',name:'管理员甲',founder:true,createdAt:invite.createdAt,disabledAt:null},
    {id:'member',name:'受邀者乙',founder:false,createdAt:invite.createdAt,disabledAt:null},
  ],nextCursor:null});
});

it('generates with the chosen expiry, shows the code and revokes the matching invitation', async () => {
  api.createAdminInvite.mockResolvedValue({code:'private-one-use-code',invite});
  render(<AccessManagementModal onClose={vi.fn()} />);
  await screen.findByText('暂无邀请码');
  fireEvent.change(screen.getByLabelText('有效期（天）'),{target:{value:'30'}});
  api.getAdminInvites.mockResolvedValue({items:[invite],nextCursor:null});
  fireEvent.click(screen.getByRole('button',{name:'生成邀请码'}));
  expect(await screen.findByLabelText('新邀请码')).toHaveValue('private-one-use-code');
  expect(api.createAdminInvite).toHaveBeenCalledWith(30);
  await waitFor(() => expect(screen.getByRole('button',{name:'撤销邀请码 …123456'})).toBeEnabled());
  api.getAdminInvites.mockResolvedValue({items:[{...invite,status:'revoked',revokedAt:invite.createdAt}],nextCursor:null});
  fireEvent.click(screen.getByRole('button',{name:'撤销邀请码 …123456'}));
  expect(await screen.findByText('已撤销')).toBeInTheDocument();
  expect(api.revokeAdminInvite).toHaveBeenCalledWith('invite-1');
  expect(screen.queryByLabelText('新邀请码')).not.toBeInTheDocument();
});

it('confirms disabling a member, keeps the administrator protected, and restores the member', async () => {
  render(<AccessManagementModal onClose={vi.fn()} />);
  await screen.findByText('暂无邀请码');
  fireEvent.click(screen.getByRole('button',{name:'账号'}));
  await screen.findByText('受邀者乙');
  expect(screen.queryByRole('button',{name:'停用账号 管理员甲'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'停用账号 受邀者乙'}));
  expect(api.setAdminAccountDisabled).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('所有设备将退出登录');
  api.getAdminAccounts.mockResolvedValue({items:[{id:'member',name:'受邀者乙',createdAt:invite.createdAt,founder:false,disabledAt:invite.createdAt}],nextCursor:null});
  fireEvent.click(screen.getByRole('button',{name:'确认停用'}));
  await waitFor(() => expect(screen.getByRole('button',{name:'恢复账号 受邀者乙'})).toBeEnabled());
  expect(api.setAdminAccountDisabled).toHaveBeenCalledWith('member',true);
  api.getAdminAccounts.mockResolvedValue({items:[{id:'member',name:'受邀者乙',createdAt:invite.createdAt,founder:false,disabledAt:null}],nextCursor:null});
  fireEvent.click(screen.getByRole('button',{name:'恢复账号 受邀者乙'}));
  await screen.findByText('账号已恢复，请用户重新登录');
  expect(api.setAdminAccountDisabled).toHaveBeenCalledWith('member',false);
});

it('keeps a failed management action visible and permits retrying it', async () => {
  api.getAdminInvites.mockResolvedValue({items:[invite],nextCursor:null});
  api.revokeAdminInvite.mockRejectedValueOnce(new Error('邀请码已使用，不能撤销'));
  render(<AccessManagementModal onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button',{name:'撤销邀请码 …123456'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('邀请码已使用');
  expect(screen.getByRole('button',{name:'撤销邀请码 …123456'})).toBeEnabled();
});
