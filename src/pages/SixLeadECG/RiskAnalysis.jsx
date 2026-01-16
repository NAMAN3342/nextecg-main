import React, { useMemo } from 'react'

/**
 * Risk Analysis Component
 * Calculates clinical ECG metrics and risk scoring
 * Algorithms: HR, HRV, QRS duration, QT/QTc, ST deviation
 */
export default function RiskAnalysis({ leadData, sampleRate = 125 }) {

    // Calculate all metrics when lead data changes
    const metrics = useMemo(() => {
        if (!leadData || !leadData.leadII || leadData.leadII.length < sampleRate * 2) {
            return getDefaultMetrics()
        }

        const samples = leadData.leadII

        // Detect R-peaks
        const rPeaks = detectRPeaks(samples, sampleRate)

        // Calculate heart rate from R-R intervals
        const hrData = calculateHeartRate(rPeaks, sampleRate)

        // Calculate HRV (SDNN and RMSSD)
        const hrvData = calculateHRV(rPeaks, sampleRate)

        // Estimate QRS duration
        const qrsData = estimateQRSDuration(samples, rPeaks, sampleRate)

        // Estimate QT interval and QTc
        const qtData = estimateQTInterval(samples, rPeaks, sampleRate, hrData.hr)

        // Check ST segment deviation
        const stData = checkSTDeviation(samples, rPeaks, sampleRate)

        // Calculate overall risk score
        const riskScore = calculateRiskScore(hrData, hrvData, qrsData, qtData, stData)

        return {
            hr: hrData,
            hrv: hrvData,
            qrs: qrsData,
            qt: qtData,
            st: stData,
            risk: riskScore
        }
    }, [leadData, sampleRate])

    function getDefaultMetrics() {
        return {
            hr: { hr: '--', status: 'unknown', rrInterval: '--' },
            hrv: { sdnn: '--', rmssd: '--', status: 'unknown' },
            qrs: { duration: '--', status: 'unknown' },
            qt: { qt: '--', qtc: '--', status: 'unknown' },
            st: { deviation: '--', status: 'unknown' },
            risk: { score: 0, level: 'unknown', factors: [] }
        }
    }

    // Simple R-peak detection using threshold crossing
    function detectRPeaks(samples, sr) {
        const peaks = []
        const windowSize = Math.floor(sr * 0.1) // 100ms window
        const minPeakDistance = Math.floor(sr * 0.3) // Minimum 300ms between R-peaks (max 200 bpm)

        // Find maximum amplitude for threshold
        let maxAmp = 0
        for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i]) > maxAmp) maxAmp = Math.abs(samples[i])
        }

        const threshold = maxAmp * 0.5

        let lastPeakIdx = -minPeakDistance

        for (let i = windowSize; i < samples.length - windowSize; i++) {
            // Check if this is a local maximum above threshold
            if (samples[i] > threshold && i - lastPeakIdx > minPeakDistance) {
                let isMax = true
                for (let j = i - windowSize; j <= i + windowSize; j++) {
                    if (j !== i && samples[j] >= samples[i]) {
                        isMax = false
                        break
                    }
                }
                if (isMax) {
                    peaks.push(i)
                    lastPeakIdx = i
                }
            }
        }

        return peaks
    }

    // Calculate heart rate from R-R intervals
    function calculateHeartRate(rPeaks, sr) {
        if (rPeaks.length < 2) {
            return { hr: '--', status: 'unknown', rrInterval: '--' }
        }

        // Calculate R-R intervals in seconds
        const rrIntervals = []
        for (let i = 1; i < rPeaks.length; i++) {
            rrIntervals.push((rPeaks[i] - rPeaks[i - 1]) / sr)
        }

        // Average R-R interval
        const avgRR = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length
        const hr = Math.round(60 / avgRR)

        // Determine status
        let status = 'normal'
        if (hr < 60) status = 'warning' // Bradycardia
        else if (hr > 100) status = 'warning' // Tachycardia
        else if (hr < 50 || hr > 120) status = 'danger'

        return {
            hr,
            status,
            rrInterval: Math.round(avgRR * 1000) // in ms
        }
    }

    // Calculate Heart Rate Variability (SDNN and RMSSD)
    function calculateHRV(rPeaks, sr) {
        if (rPeaks.length < 3) {
            return { sdnn: '--', rmssd: '--', status: 'unknown' }
        }

        // Calculate R-R intervals in ms
        const rrIntervals = []
        for (let i = 1; i < rPeaks.length; i++) {
            rrIntervals.push((rPeaks[i] - rPeaks[i - 1]) / sr * 1000)
        }

        // SDNN: Standard deviation of NN intervals
        const mean = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length
        const variance = rrIntervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / rrIntervals.length
        const sdnn = Math.round(Math.sqrt(variance))

        // RMSSD: Root mean square of successive differences
        let sumSquaredDiff = 0
        for (let i = 1; i < rrIntervals.length; i++) {
            sumSquaredDiff += Math.pow(rrIntervals[i] - rrIntervals[i - 1], 2)
        }
        const rmssd = Math.round(Math.sqrt(sumSquaredDiff / (rrIntervals.length - 1)))

        // HRV status (SDNN < 50ms is concerning)
        let status = 'normal'
        if (sdnn < 50) status = 'warning'
        if (sdnn < 30) status = 'danger'

        return { sdnn, rmssd, status }
    }

    // Estimate QRS duration
    function estimateQRSDuration(samples, rPeaks, sr) {
        if (rPeaks.length < 1) {
            return { duration: '--', status: 'unknown' }
        }

        // Analyze the area around R-peaks to estimate QRS width
        const qrsWidths = []
        const searchWindow = Math.floor(sr * 0.1) // 100ms around R-peak
        const threshold = 0.3 // 30% of R-peak amplitude

        for (const peakIdx of rPeaks) {
            const peakAmp = samples[peakIdx]
            let qStart = peakIdx
            let qEnd = peakIdx

            // Find Q-wave start (backward from R)
            for (let i = peakIdx; i > Math.max(0, peakIdx - searchWindow); i--) {
                if (Math.abs(samples[i]) < Math.abs(peakAmp) * threshold) {
                    qStart = i
                    break
                }
            }

            // Find S-wave end (forward from R)
            for (let i = peakIdx; i < Math.min(samples.length, peakIdx + searchWindow); i++) {
                if (Math.abs(samples[i]) < Math.abs(peakAmp) * threshold) {
                    qEnd = i
                    break
                }
            }

            const qrsMs = ((qEnd - qStart) / sr) * 1000
            if (qrsMs > 40 && qrsMs < 200) { // Sanity check
                qrsWidths.push(qrsMs)
            }
        }

        if (qrsWidths.length === 0) {
            return { duration: '--', status: 'unknown' }
        }

        const avgQRS = Math.round(qrsWidths.reduce((a, b) => a + b, 0) / qrsWidths.length)

        // QRS > 120ms is abnormal (bundle branch block)
        let status = 'normal'
        if (avgQRS > 100) status = 'warning'
        if (avgQRS > 120) status = 'danger'

        return { duration: avgQRS, status }
    }

    // Estimate QT interval
    function estimateQTInterval(samples, rPeaks, sr, hr) {
        if (rPeaks.length < 2 || hr === '--' || hr <= 0) {
            return { qt: '--', qtc: '--', status: 'unknown' }
        }

        // QT is typically ~40% of R-R interval
        // This is a simplified estimation
        const avgRR = 60 / hr // seconds
        const estimatedQT = avgRR * 0.4 * 1000 // ms

        // Bazett formula for QTc: QTc = QT / sqrt(RR)
        const qtc = Math.round(estimatedQT / Math.sqrt(avgRR))

        // QTc > 450ms (men) or > 460ms (women) is prolonged
        let status = 'normal'
        if (qtc > 430) status = 'warning'
        if (qtc > 450) status = 'danger'

        return {
            qt: Math.round(estimatedQT),
            qtc,
            status
        }
    }

    // Check ST segment deviation
    function checkSTDeviation(samples, rPeaks, sr) {
        if (rPeaks.length < 2) {
            return { deviation: '--', status: 'unknown' }
        }

        // ST segment is ~80ms after J-point (end of QRS)
        const jPointOffset = Math.floor(sr * 0.06) // ~60ms after R
        const stOffset = Math.floor(sr * 0.08) // ~80ms for ST measurement

        const stDeviations = []

        for (let i = 0; i < rPeaks.length - 1; i++) {
            const peakIdx = rPeaks[i]
            const nextPeakIdx = rPeaks[i + 1]

            // Find isoelectric baseline (before R-peak, in TP segment)
            const baselineStart = peakIdx - Math.floor(sr * 0.1)
            let baseline = 0
            let count = 0
            for (let j = Math.max(0, baselineStart); j < peakIdx - Math.floor(sr * 0.05); j++) {
                baseline += samples[j]
                count++
            }
            baseline = count > 0 ? baseline / count : 0

            // Measure ST segment
            const stIdx = peakIdx + jPointOffset + stOffset
            if (stIdx < nextPeakIdx && stIdx < samples.length) {
                const stValue = samples[stIdx]
                const deviation = (stValue - baseline) // in mV
                stDeviations.push(deviation)
            }
        }

        if (stDeviations.length === 0) {
            return { deviation: '--', status: 'unknown' }
        }

        const avgDeviation = stDeviations.reduce((a, b) => a + b, 0) / stDeviations.length
        const deviationMm = avgDeviation * 10 // Convert mV to mm (10mm/mV)

        // ST elevation/depression > 1mm is significant
        let status = 'normal'
        if (Math.abs(deviationMm) > 0.5) status = 'warning'
        if (Math.abs(deviationMm) > 1.0) status = 'danger'

        return {
            deviation: deviationMm.toFixed(1),
            status
        }
    }

    // Calculate overall risk score
    function calculateRiskScore(hr, hrv, qrs, qt, st) {
        let score = 0
        const factors = []

        // Heart rate scoring
        if (hr.status === 'warning') { score += 1; factors.push('HR abnormal') }
        if (hr.status === 'danger') { score += 2; factors.push('HR critical') }

        // HRV scoring
        if (hrv.status === 'warning') { score += 1; factors.push('Low HRV') }
        if (hrv.status === 'danger') { score += 2; factors.push('Very low HRV') }

        // QRS scoring
        if (qrs.status === 'warning') { score += 1; factors.push('Wide QRS') }
        if (qrs.status === 'danger') { score += 2; factors.push('QRS >120ms') }

        // QT scoring
        if (qt.status === 'warning') { score += 1; factors.push('Borderline QTc') }
        if (qt.status === 'danger') { score += 2; factors.push('Prolonged QTc') }

        // ST scoring
        if (st.status === 'warning') { score += 1; factors.push('ST deviation') }
        if (st.status === 'danger') { score += 3; factors.push('Significant ST change') }

        // Determine overall risk level
        let level = 'low'
        if (score >= 3) level = 'medium'
        if (score >= 6) level = 'high'

        return { score, level, factors }
    }

    function getStatusColor(status) {
        switch (status) {
            case 'normal': return '#059669'
            case 'warning': return '#d97706'
            case 'danger': return '#dc2626'
            default: return '#718096'
        }
    }

    function getStatusBg(status) {
        switch (status) {
            case 'normal': return '#d1fae5'
            case 'warning': return '#fef3c7'
            case 'danger': return '#fee2e2'
            default: return '#f3f4f6'
        }
    }

    return (
        <div className="risk-panel">
            <div className="risk-header">
                <span style={{ fontSize: '20px' }}>🩺</span>
                <span className="risk-title">Risk Assessment</span>
                <span style={{
                    marginLeft: 'auto',
                    fontSize: '11px',
                    color: '#718096'
                }}>
                    Real-time Analysis
                </span>
            </div>

            <div className="risk-grid">
                {/* Heart Rate */}
                <div className="risk-item">
                    <div className="risk-item-label">Heart Rate</div>
                    <div className="risk-item-value" style={{ color: getStatusColor(metrics.hr.status) }}>
                        {metrics.hr.hr}
                        <span className="risk-item-unit">bpm</span>
                    </div>
                    <div className="risk-status" style={{
                        background: getStatusBg(metrics.hr.status),
                        color: getStatusColor(metrics.hr.status)
                    }}>
                        {metrics.hr.status === 'normal' ? '✓ Normal' :
                            metrics.hr.status === 'warning' ? '⚠ Abnormal' :
                                metrics.hr.status === 'danger' ? '⚠ Critical' : '...'
                        }
                    </div>
                </div>

                {/* HRV */}
                <div className="risk-item">
                    <div className="risk-item-label">HRV (SDNN)</div>
                    <div className="risk-item-value" style={{ color: getStatusColor(metrics.hrv.status) }}>
                        {metrics.hrv.sdnn}
                        <span className="risk-item-unit">ms</span>
                    </div>
                    <div className="risk-status" style={{
                        background: getStatusBg(metrics.hrv.status),
                        color: getStatusColor(metrics.hrv.status)
                    }}>
                        {metrics.hrv.status === 'normal' ? '✓ Normal' :
                            metrics.hrv.status === 'warning' ? '⚠ Low' :
                                metrics.hrv.status === 'danger' ? '⚠ Very Low' : '...'
                        }
                    </div>
                </div>

                {/* QRS Duration */}
                <div className="risk-item">
                    <div className="risk-item-label">QRS Duration</div>
                    <div className="risk-item-value" style={{ color: getStatusColor(metrics.qrs.status) }}>
                        {metrics.qrs.duration}
                        <span className="risk-item-unit">ms</span>
                    </div>
                    <div className="risk-status" style={{
                        background: getStatusBg(metrics.qrs.status),
                        color: getStatusColor(metrics.qrs.status)
                    }}>
                        {metrics.qrs.status === 'normal' ? '✓ Normal' :
                            metrics.qrs.status === 'warning' ? '⚠ Wide' :
                                metrics.qrs.status === 'danger' ? '⚠ Prolonged' : '...'
                        }
                    </div>
                </div>

                {/* QTc Interval */}
                <div className="risk-item">
                    <div className="risk-item-label">QTc Interval</div>
                    <div className="risk-item-value" style={{ color: getStatusColor(metrics.qt.status) }}>
                        {metrics.qt.qtc}
                        <span className="risk-item-unit">ms</span>
                    </div>
                    <div className="risk-status" style={{
                        background: getStatusBg(metrics.qt.status),
                        color: getStatusColor(metrics.qt.status)
                    }}>
                        {metrics.qt.status === 'normal' ? '✓ Normal' :
                            metrics.qt.status === 'warning' ? '⚠ Borderline' :
                                metrics.qt.status === 'danger' ? '⚠ Prolonged' : '...'
                        }
                    </div>
                </div>

                {/* ST Deviation */}
                <div className="risk-item">
                    <div className="risk-item-label">ST Deviation</div>
                    <div className="risk-item-value" style={{ color: getStatusColor(metrics.st.status) }}>
                        {metrics.st.deviation}
                        <span className="risk-item-unit">mm</span>
                    </div>
                    <div className="risk-status" style={{
                        background: getStatusBg(metrics.st.status),
                        color: getStatusColor(metrics.st.status)
                    }}>
                        {metrics.st.status === 'normal' ? '✓ Normal' :
                            metrics.st.status === 'warning' ? '⚠ Deviation' :
                                metrics.st.status === 'danger' ? '⚠ Significant' : '...'
                        }
                    </div>
                </div>

                {/* R-R Interval */}
                <div className="risk-item">
                    <div className="risk-item-label">R-R Interval</div>
                    <div className="risk-item-value" style={{ color: '#1e40af' }}>
                        {metrics.hr.rrInterval}
                        <span className="risk-item-unit">ms</span>
                    </div>
                    <div className="risk-status" style={{ background: '#dbeafe', color: '#1e40af' }}>
                        Rhythm
                    </div>
                </div>
            </div>

            {/* Overall Risk Score */}
            <div className="overall-risk">
                <span className="risk-score-label">Overall Risk Level:</span>
                <span className={`risk-score-value ${metrics.risk.level}`}>
                    {metrics.risk.level === 'low' ? '● LOW RISK' :
                        metrics.risk.level === 'medium' ? '● MODERATE' :
                            metrics.risk.level === 'high' ? '● HIGH RISK' : 'ANALYZING...'}
                </span>
            </div>

            {/* Risk Factors */}
            {metrics.risk.factors.length > 0 && (
                <div style={{
                    marginTop: '10px',
                    padding: '10px',
                    background: '#fef2f2',
                    borderRadius: '6px',
                    fontSize: '12px',
                    color: '#991b1b'
                }}>
                    <strong>⚠ Factors:</strong> {metrics.risk.factors.join(', ')}
                </div>
            )}

            {/* Disclaimer */}
            <div style={{
                marginTop: '12px',
                fontSize: '10px',
                color: '#9ca3af',
                textAlign: 'center',
                fontStyle: 'italic'
            }}>
                For educational purposes only. Not for clinical diagnosis.
            </div>
        </div>
    )
}
