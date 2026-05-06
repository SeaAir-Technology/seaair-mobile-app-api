import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginGate } from './auth/LoginGate';
import { AccessGate } from './auth/AccessGate';
import { Layout } from './components/Layout';
import { DevicesPage } from './pages/DevicesPage';
import { BeaconsPage } from './pages/BeaconsPage';
import { AdminPage } from './pages/AdminPage';

export default function App(): JSX.Element {
  return (
    <LoginGate>
      <AccessGate>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/devices" replace />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/devices/:controllerId" element={<DevicesPage />} />
            <Route path="/beacons" element={<BeaconsPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/devices" replace />} />
          </Route>
        </Routes>
      </AccessGate>
    </LoginGate>
  );
}
