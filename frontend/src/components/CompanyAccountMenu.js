import React, { useState } from 'react';
import { Button, Dropdown, Form, Input, Modal, Typography, message } from 'antd';
import { UserOutlined } from '@ant-design/icons';

export default function CompanyAccountMenu({ auth }) {
  const [dialog, setDialog] = useState('');
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  if (!auth?.user) return null;
  const submit = async values => {
    setBusy(true);
    try {
      await auth.changePassword(values);
      message.success('密码已修改，请重新登录');
      form.resetFields();
      setDialog('');
    } catch (error) { message.error(error.message); }
    finally { setBusy(false); }
  };
  const open = value => { form.resetFields(); setDialog(value); };
  return <>
    <Dropdown menu={{ items: [
      { key: 'profile', label: <span>{auth.user.name} · 管理员</span>, disabled: true },
      { key: 'password', label: '修改我的密码', onClick: () => open('password') },
      { type: 'divider' },
      { key: 'logout', label: '退出登录', onClick: auth.logout }
    ] }} placement="bottomRight">
      <Button icon={<UserOutlined />}>{auth.user.name} · 管理员</Button>
    </Dropdown>
    <Modal title="修改我的密码"
      open={Boolean(dialog)} onCancel={() => setDialog('')} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} style={{ marginTop: 18 }}>
        <Form.Item label="当前密码" name="currentPassword"
          rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item label="新密码" name="newPassword"
          rules={[{ required: true, min: 8, message: '至少 8 个字符' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="确认新密码" name="confirmPassword" dependencies={['newPassword']}
          rules={[{ required: true, message: '请再次输入新密码' }, ({ getFieldValue }) => ({
            validator(_, value) {
              return value === getFieldValue('newPassword') ? Promise.resolve()
                : Promise.reject(new Error('两次输入的新密码不一致'));
            }
          })]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Typography.Text type="secondary">新密码不能与当前密码相同。</Typography.Text>
        <Button type="primary" htmlType="submit" loading={busy} style={{ display: 'block', marginTop: 18 }}>
          保存并重新登录
        </Button>
      </Form>
    </Modal>
  </>;
}
