import './SixLeadECG.css'
import ECGVisualizer from './ECGVisualizer'
import { useNavigate } from 'react-router-dom'

export default function SixLeadECGPage() {
    const navigate = useNavigate()

    return (
        <div className="app">
            <header className="header">
                <div className="header-content">
                    <div className="logo-section">
                        <button
                            onClick={() => navigate('/')}
                            style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '8px',
                                marginRight: '8px',
                                borderRadius: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}
                            title="Back to Home"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a1a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M19 12H5M12 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <div className="heartbeat-icon">
                            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path className="heartbeat-line" d="M2 20 L10 20 L13 8 L17 32 L21 12 L25 28 L29 20 L38 20"
                                    stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            </svg>
                        </div>
                        <div className="brand-text">
                            <h1 className="brand-title">
                                <span className="brand-next">Next</span><span className="brand-ecg">ECG</span>
                            </h1>
                            <p className="brand-subtitle">Professional 6-Lead Cardiac Monitor</p>
                        </div>
                    </div>
                    <p className="header-info">Real-time ECG • Vectorcardiogram • Risk Assessment • Clinical-grade Analysis</p>
                </div>
            </header>
            <main>
                <ECGVisualizer />
            </main>
        </div>
    )
}
