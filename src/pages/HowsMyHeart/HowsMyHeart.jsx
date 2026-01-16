import { useNavigate } from 'react-router-dom'
import ECGMonitorUI from './ECGMonitorUI'

export default function HowsMyHeart() {
    const navigate = useNavigate()

    return (
        <div style={{ position: 'relative' }}>
            {/* Back Button */}
            <button
                onClick={() => navigate('/')}
                style={{
                    position: 'absolute',
                    top: '20px',
                    left: '20px',
                    zIndex: 100,
                    background: '#ffffff',
                    border: '1px solid #e5e7eb',
                    cursor: 'pointer',
                    padding: '10px 16px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontWeight: 600,
                    fontSize: '14px',
                    color: '#1f2937',
                    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
                    transition: 'all 0.2s ease'
                }}
                title="Back to Home"
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Home
            </button>
            <ECGMonitorUI />
        </div>
    )
}
