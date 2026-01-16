import React, { useRef, useState, useEffect } from 'react'

// Helper to split text stream by newlines
class LineBreakTransformer {
    constructor() { this.container = '' }
    transform(chunk, controller) {
        this.container += chunk;
        const lines = this.container.split('\n');
        this.container = lines.pop();
        for (const line of lines) controller.enqueue(line);
    }
    flush(controller) {
        if (this.container) controller.enqueue(this.container);
    }
}

function computeStats(arr) {
    if (!arr || arr.length === 0) return { mean: 0, sd: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length);
    return { mean, sd };
}

export default function ECGMonitorUI() {
    const canvasRef = useRef(null);
    const [port, setPort] = useState(null);
    const [bpm, setBpm] = useState(null);
    const [lastSerialLine, setLastSerialLine] = useState('');
    const [lastParsedBpm, setLastParsedBpm] = useState(null);
    const [lastParsedIrr, setLastParsedIrr] = useState(null);
    const [healthCategory, setHealthCategory] = useState({ level: '--', score: 0, desc: '' });
    const [breakdown, setBreakdown] = useState({ brady: 0, tachy: 0, irregularity: 0 });
    const [calibrating, setCalibrating] = useState(false);
    const [monitoringActive, setMonitoringActive] = useState(false);
    const [sessionComplete, setSessionComplete] = useState(false);
    const [sessionTime, setSessionTime] = useState(0);
    const [connecting, setConnecting] = useState(false);
    const [averageBpm, setAverageBpm] = useState(null);
    const [healthMetrics, setHealthMetrics] = useState(null); // Store all calculated HRV metrics

    const samplesRef = useRef([]);
    const samples2Ref = useRef([]);
    const beatsRef = useRef([]); // Store timestamps of detected R-peaks
    const bpmReadingsRef = useRef([]);
    const lastPeakTimeRef = useRef(0); // For peak detection refractory period
    const monitoringActiveRef = useRef(false);
    const sessionCompleteRef = useRef(false);
    const MAX_SAMPLES = 1500;
    const ARDUINO_SAMPLE_RATE = 125;
    const SAMPLE_PERIOD_MS = 1000 / ARDUINO_SAMPLE_RATE;

    // Session timer
    useEffect(() => {
        let timer;
        if (monitoringActive && !sessionComplete) {
            timer = setInterval(() => {
                setSessionTime(prev => prev + 1);
            }, 1000);
        }
        return () => clearInterval(timer);
    }, [monitoringActive, sessionComplete]);

    // Update refs for use in intervals
    useEffect(() => { monitoringActiveRef.current = monitoringActive; }, [monitoringActive]);
    useEffect(() => { sessionCompleteRef.current = sessionComplete; }, [sessionComplete]);

    // Canvas rendering loop
    useEffect(() => {
        let anim = true;
        const render = () => {
            if (!anim) return;
            drawCanvas();
            requestAnimationFrame(render);
        };
        requestAnimationFrame(render);
        return () => { anim = false };
    }, []);

    // R-peak detection
    useEffect(() => {
        const MIN_BEAT_INTERVAL = 300;
        let lastPeakTime = 0;
        let lastProcessedIndex = 0;

        const detectionInterval = setInterval(() => {
            const samples = samplesRef.current;
            const n = samples.length;
            if (n < 50) return;

            const recent = samples.slice(Math.max(0, n - 200));
            const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
            const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
            const sd = Math.sqrt(variance);
            const thresh = mean + Math.max(0.25, sd * 0.8);

            for (let i = Math.max(1, lastProcessedIndex); i < n - 1; i++) {
                const v = samples[i];
                if (v > samples[i - 1] && v > samples[i + 1] && v > thresh) {
                    const now = Date.now();
                    if (now - lastPeakTime > MIN_BEAT_INTERVAL) {
                        lastPeakTime = now;
                        beatsRef.current.push(now);
                        if (beatsRef.current.length > 50) beatsRef.current.splice(0, beatsRef.current.length - 50);

                        if (beatsRef.current.length >= 2) {
                            const ibi = now - beatsRef.current[beatsRef.current.length - 2];
                            const measuredBpm = Math.round(60000 / ibi);
                            setBpm(measuredBpm);

                            // Capture readings if recording
                            if (monitoringActiveRef.current && !sessionCompleteRef.current) {
                                if (measuredBpm > 30 && measuredBpm < 220) {
                                    bpmReadingsRef.current.push(measuredBpm);
                                }
                            }
                        }

                        if (beatsRef.current.length >= 3) {
                            const ibis = [];
                            for (let j = 1; j < beatsRef.current.length; j++) ibis.push(beatsRef.current[j] - beatsRef.current[j - 1]);
                            const lastIbis = ibis.slice(-8);
                            const meanI = lastIbis.reduce((a, b) => a + b, 0) / lastIbis.length;
                            let varI = 0;
                            for (const x of lastIbis) varI += Math.pow(x - meanI, 2);
                            varI /= lastIbis.length;
                            const sdI = Math.sqrt(varI);
                            const cv = meanI > 0 ? sdI / meanI : 0;
                            const irrNorm = Math.min(1, cv * 3.0);
                            if (!window.arduinoIrregularity) window.arduinoIrregularity = [];
                            window.arduinoIrregularity.push(irrNorm);
                            if (window.arduinoIrregularity.length > 10) window.arduinoIrregularity.shift();
                        }
                    }
                }
            }

            lastProcessedIndex = Math.max(0, n - 2);
        }, Math.max(20, Math.round(SAMPLE_PERIOD_MS * 4)));

        return () => clearInterval(detectionInterval);
    }, []);

    // Health metrics calculation
    useEffect(() => {
        const compute = () => {
            const beats = beatsRef.current;
            const hasArduinoIrr = window.arduinoIrregularity && window.arduinoIrregularity.length > 0;

            if (!monitoringActive) {
                setHealthCategory({ level: 'Calibrating...', score: 0, desc: 'Collecting baseline ECG data for accurate analysis.' });
                return;
            }

            if (!hasArduinoIrr && beats.length < 3) {
                setHealthCategory({ level: 'Analyzing...', score: 0, desc: 'Collecting heartbeat data for rhythm assessment.' });
                return;
            }

            let irregularity = 0;
            if (hasArduinoIrr) {
                const recent = window.arduinoIrregularity.slice(-5);
                irregularity = recent.reduce((a, b) => a + b, 0) / recent.length;
            } else {
                const ibis = [];
                for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
                const last = ibis.slice(-8);
                const { mean, sd } = computeStats(last);
                const cv = mean > 0 ? sd / mean : 0;
                irregularity = Math.min(1, cv * 3.0);
            }

            const hr = bpm || 70;
            let bradyScore = 0;
            let tachyScore = 0;
            if (hr < 50) bradyScore = 40;
            else if (hr < 60) bradyScore = 20;
            if (hr > 120) tachyScore = 40;
            else if (hr > 100) tachyScore = 20;
            const irrScore = Math.round(irregularity * 40);

            let score = bradyScore + tachyScore + irrScore;
            score = Math.max(0, Math.min(100, score));

            let level = 'Normal';
            let desc = 'Heart rate and rhythm are within typical ranges.';
            if (score >= 70) { level = 'High'; desc = 'High concern: heart rate or rhythm suggest elevated risk — seek medical attention if symptomatic.' }
            else if (score >= 35) { level = 'Moderate'; desc = 'Moderate concern: some abnormal findings. Consider monitoring and consulting a clinician.' }

            setBreakdown({ brady: bradyScore, tachy: tachyScore, irregularity: irrScore });
            setHealthCategory({ level, score, desc });
        };

        const id = setInterval(compute, 1000);
        return () => clearInterval(id);
    }, [bpm, monitoringActive]);

    function drawCanvas() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width = canvas.clientWidth;
        const h = canvas.height = Math.round(w * 0.32);

        // White background (standard ECG paper)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        // ECG Grid - Red grid like standard medical ECG paper
        const gridSize = 20; // 5mm major grid
        const smallGrid = gridSize / 5; // 1mm minor grid

        // Minor grid lines (lighter red)
        ctx.strokeStyle = '#ffcccc';
        ctx.lineWidth = 0.5;
        for (let x = 0; x < w; x += smallGrid) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let y = 0; y < h; y += smallGrid) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        // Major grid lines (darker red)
        ctx.strokeStyle = '#ff9999';
        ctx.lineWidth = 1;
        for (let x = 0; x < w; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let y = 0; y < h; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        const samples = samplesRef.current;
        if (samples.length < 2) {
            ctx.fillStyle = '#6c757d';
            ctx.font = '600 16px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            if (calibrating) {
                ctx.fillText('CALIBRATING ECG', w / 2, h / 2 - 10);
                ctx.fillStyle = '#adb5bd';
                ctx.font = '400 13px system-ui, -apple-system, sans-serif';
                ctx.fillText('Collecting baseline data...', w / 2, h / 2 + 15);
            } else if (!port) {
                ctx.fillText('NO ECG SIGNAL', w / 2, h / 2 - 10);
                ctx.fillStyle = '#adb5bd';
                ctx.font = '400 13px system-ui, -apple-system, sans-serif';
                ctx.fillText('Connect device to begin monitoring', w / 2, h / 2 + 15);
            }
            return;
        }

        // Draw ECG waveform
        const DISPLAY_SECONDS = 6;
        const SAMPLES_TO_DISPLAY = ARDUINO_SAMPLE_RATE * DISPLAY_SECONDS;
        const view = samples.slice(-SAMPLES_TO_DISPLAY);

        ctx.strokeStyle = '#10b981'; // Green ECG trace
        ctx.lineWidth = 2;
        ctx.beginPath();

        const minV = -2.0;
        const maxV = 2.0;

        for (let i = 0; i < view.length; i++) {
            const x = (i / ARDUINO_SAMPLE_RATE) * (25 * gridSize / 5);
            const v = view[i];
            const y = h / 2 - (v / (maxV - minV)) * h * 0.8;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    async function connectSerial() {
        if (!('serial' in navigator)) {
            alert('Web Serial API not supported. Please use Chrome or Edge browser.');
            return;
        }

        setConnecting(true);

        // Give React time to render the loading state before the native picker opens
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            const requestedPort = await navigator.serial.requestPort();
            await requestedPort.open({ baudRate: 115200 });
            setPort(requestedPort);
            setCalibrating(true);
            setMonitoringActive(false);
            setConnecting(false);
            setSessionTime(0);
            setAverageBpm(null);
            setHealthMetrics(null);
            bpmReadingsRef.current = [];

            // 1. Calibration (4s)
            setTimeout(() => {
                setCalibrating(false);
                setMonitoringActive(true);

                // 2. Recording (15s)
                setTimeout(() => {
                    setSessionComplete(true);
                    setMonitoringActive(false);

                    // --- CALCULATION PHASE ---
                    const readings = bpmReadingsRef.current;
                    const beats = beatsRef.current;

                    let avgBpmVal = 0;
                    if (readings.length > 0) {
                        const sum = readings.reduce((a, b) => a + b, 0);
                        avgBpmVal = Math.round(sum / readings.length);
                        setAverageBpm(avgBpmVal);
                    } else if (beats.length >= 2) {
                        // Fallback calculation using beats time difference
                        const durationMinutes = (beats[beats.length - 1] - beats[0]) / 60000;
                        if (durationMinutes > 0) {
                            avgBpmVal = Math.round((beats.length - 1) / durationMinutes);
                            setAverageBpm(avgBpmVal);
                        }
                    }

                    let rrIntervals = [];
                    for (let i = 1; i < beats.length; i++) {
                        rrIntervals.push(beats[i] - beats[i - 1]);
                    }

                    if (rrIntervals.length < 2 && readings.length > 0) {
                        rrIntervals = readings.map(b => 60000 / b);
                    }

                    if (rrIntervals.length >= 2) {
                        const meanRR = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
                        const variance = rrIntervals.reduce((a, b) => a + Math.pow(b - meanRR, 2), 0) / rrIntervals.length;
                        const sdnn = Math.sqrt(variance);

                        let sumSquaredDiffs = 0;
                        let countDiffs50 = 0;
                        for (let i = 0; i < rrIntervals.length - 1; i++) {
                            const diff = rrIntervals[i] - rrIntervals[i + 1];
                            sumSquaredDiffs += diff * diff;
                            if (Math.abs(diff) > 50) countDiffs50++;
                        }
                        const rmssd = Math.sqrt(sumSquaredDiffs / (rrIntervals.length - 1));
                        const pnn50 = (countDiffs50 / (rrIntervals.length - 1)) * 100;
                        const irr = sdnn / meanRR;
                        const sd1 = rmssd / Math.sqrt(2);
                        const isAfibRisk = (irr > 0.12 && pnn50 < 10 && sd1 < 20);

                        let score = 70;
                        if (avgBpmVal >= 60 && avgBpmVal <= 100) score += 10; else score -= 10;
                        if (sdnn > 50) score += 10;
                        if (rmssd > 30) score += 10;
                        if (irr < 0.05) score += 10; else if (irr > 0.12) score -= 20;
                        if (isAfibRisk) score -= 30;
                        score = Math.max(0, Math.min(100, score));

                        setHealthMetrics({ sdnn, rmssd, pnn50, irr, sd1, isAfibRisk, score, meanRR });
                    }
                }, 15000);
            }, 4000);

            const textDecoder = new TextDecoderStream();
            const readableStreamClosed = requestedPort.readable.pipeTo(textDecoder.writable);
            const reader = textDecoder.readable
                .pipeThrough(new TransformStream(new LineBreakTransformer()))
                .getReader();

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value) continue;

                const line = value.trim();
                setLastSerialLine(line);

                if (line.includes('Calibration') || line.includes('Starting') || line.includes('Baseline') || line.includes('Gain')) {
                    console.log('Arduino:', line);
                    if (line.includes('Complete')) {
                        setCalibrating(false);
                    }
                    continue;
                }

                const parts = line.split(',');
                if (parts.length >= 2) {
                    const val1 = parseFloat(parts[0]);
                    const val2 = parseFloat(parts[1]);
                    const arduinoBPM = parts.length >= 3 ? parseInt(parts[2]) : null;
                    const arduinoIrregularity = parts.length >= 4 ? parseFloat(parts[3]) : null;

                    if (!isNaN(val1) && !isNaN(val2)) {
                        samplesRef.current.push(val2);
                        samples2Ref.current.push(val1);

                        if (samplesRef.current.length > MAX_SAMPLES) {
                            samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES);
                            samples2Ref.current.splice(0, samples2Ref.current.length - MAX_SAMPLES);
                        }

                        if (arduinoBPM && arduinoBPM > 0) {
                            const now = Date.now();
                            beatsRef.current.push(now);
                            if (beatsRef.current.length > 50) {
                                beatsRef.current.splice(0, beatsRef.current.length - 50);
                            }

                            if (arduinoIrregularity !== null && arduinoIrregularity >= 0) {
                                if (!window.arduinoIrregularity) window.arduinoIrregularity = [];
                                window.arduinoIrregularity.push(arduinoIrregularity);
                                if (window.arduinoIrregularity.length > 10) {
                                    window.arduinoIrregularity.shift();
                                }
                                setLastParsedIrr(arduinoIrregularity);
                            }

                            if (monitoringActive && !sessionComplete) {
                                setBpm(arduinoBPM);
                                setLastParsedBpm(arduinoBPM);
                                if (arduinoBPM > 30 && arduinoBPM < 220) {
                                    bpmReadingsRef.current.push(arduinoBPM);
                                }

                                // Simple Peak Detection for HRV
                                const now = Date.now();
                                const val = parseFloat(parts[0]);
                                const signalThreshold = 600; // Adjusted threshold

                                // Refractory period 250ms (limit max bpm ~240)
                                if (val > signalThreshold && (now - lastPeakTimeRef.current > 250)) {
                                    beatsRef.current.push(now);
                                    lastPeakTimeRef.current = now;
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Serial connect error', err);
            setCalibrating(false);
            setConnecting(false);
        }
    }

    async function disconnectSerial() {
        if (!port) return;
        try {
            await port.close();
        } catch (e) { }
        setPort(null);
        setCalibrating(false);
        setMonitoringActive(false);
        setSessionComplete(false);
        setBpm(null);
        setSessionTime(0);
        samplesRef.current = [];
        samples2Ref.current = [];
        beatsRef.current = [];
        if (window.arduinoIrregularity) window.arduinoIrregularity = [];
    }

    function resetSession() {
        setSessionComplete(false);
        setCalibrating(true);
        setMonitoringActive(false);
        setBpm(null);
        setAverageBpm(null);
        setHealthMetrics(null);
        setSessionTime(0);
        samplesRef.current = [];
        samples2Ref.current = [];
        beatsRef.current = [];
        bpmReadingsRef.current = [];
        if (window.arduinoIrregularity) window.arduinoIrregularity = [];

        setTimeout(() => {
            setCalibrating(false);
            setMonitoringActive(true);

            setTimeout(() => {
                setSessionComplete(true);
                setMonitoringActive(false);

                // --- CALCULATION PHASE ---
                const readings = bpmReadingsRef.current;
                const beats = beatsRef.current;

                let avgBpmVal = 0;
                if (readings.length > 0) {
                    const sum = readings.reduce((a, b) => a + b, 0);
                    avgBpmVal = Math.round(sum / readings.length);
                    setAverageBpm(avgBpmVal);
                } else if (beats.length >= 2) {
                    const durationMinutes = (beats[beats.length - 1] - beats[0]) / 60000;
                    if (durationMinutes > 0) {
                        avgBpmVal = Math.round((beats.length - 1) / durationMinutes);
                        setAverageBpm(avgBpmVal);
                    }
                }

                let rrIntervals = [];
                for (let i = 1; i < beats.length; i++) {
                    rrIntervals.push(beats[i] - beats[i - 1]);
                }

                if (rrIntervals.length < 2 && readings.length > 0) {
                    rrIntervals = readings.map(b => 60000 / b);
                }

                if (rrIntervals.length >= 2) {
                    const meanRR = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
                    const variance = rrIntervals.reduce((a, b) => a + Math.pow(b - meanRR, 2), 0) / rrIntervals.length;
                    const sdnn = Math.sqrt(variance);

                    let sumSquaredDiffs = 0;
                    let countDiffs50 = 0;
                    for (let i = 0; i < rrIntervals.length - 1; i++) {
                        const diff = rrIntervals[i] - rrIntervals[i + 1];
                        sumSquaredDiffs += diff * diff;
                        if (Math.abs(diff) > 50) countDiffs50++;
                    }
                    const rmssd = Math.sqrt(sumSquaredDiffs / (rrIntervals.length - 1));
                    const pnn50 = (countDiffs50 / (rrIntervals.length - 1)) * 100;
                    const irr = sdnn / meanRR;
                    const sd1 = rmssd / Math.sqrt(2);
                    const isAfibRisk = (irr > 0.12 && pnn50 < 10 && sd1 < 20);

                    let score = 70;
                    if (avgBpmVal >= 60 && avgBpmVal <= 100) score += 10; else score -= 10;
                    if (sdnn > 50) score += 10;
                    if (rmssd > 30) score += 10;
                    if (irr < 0.05) score += 10; else if (irr > 0.12) score -= 20;
                    if (isAfibRisk) score -= 30;
                    score = Math.max(0, Math.min(100, score));

                    setHealthMetrics({ sdnn, rmssd, pnn50, irr, sd1, isAfibRisk, score, meanRR });
                }
            }, 15000);
        }, 4000);
    }

    // Get connection status
    const getConnectionStatus = () => {
        if (connecting) return 'Connecting';
        if (calibrating) return 'Calibrating';
        if (monitoringActive) return 'Recording';
        if (sessionComplete) return 'Complete';
        if (port) return 'Connected';
        return 'Disconnected';
    };

    const connectionStatus = getConnectionStatus();

    const getHeartRateStatus = (val) => {
        if (!val) return null;
        if (val < 50) return { label: 'High Risk', meaning: 'Severe bradycardia', color: '#ef4444' };
        if (val < 60) return { label: 'Low', meaning: 'Mild bradycardia', color: '#eab308' };
        if (val <= 100) return { label: 'Normal', meaning: 'Healthy resting rhythm', color: '#22c55e' };
        if (val <= 120) return { label: 'Moderate', meaning: 'Mild tachycardia', color: '#eab308' };
        return { label: 'High Risk', meaning: 'Severe tachycardia', color: '#ef4444' };
    };

    const resultStatus = sessionComplete && averageBpm ? getHeartRateStatus(averageBpm) : null;

    const [hoveredMetric, setHoveredMetric] = useState(null);
    const metricExplanations = {
        SDNN: "Standard Deviation of NN intervals. Reflects total variability and overall autonomic health. Higher is better.",
        RMSSD: "Root Mean Square of Successive Differences. Primary marker for parasympathetic (rest & digest) activity.",
        pNN50: "Percentage of beats differing by >50ms. Indicates beat-to-beat stability. Low values (<10%) suggest stress.",
        IRR: "Irregularity Index. Measures randomness of rhythm. Values > 0.12 may indicate Atrial Fibrillation (AFib).",
        SD1: "Poincaré short-axis width. Represents instantaneous beat-to-beat variability.",
        AFib: "Algorithmic decision rule based on Irregularity, Stability, and Pattern width."
    };

    return (
        <div style={styles.container}>
            <style>{`
                @keyframes spinLoader {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                @keyframes spinWave {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                @keyframes spinWaveReverse {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(-360deg); }
                }
            `}</style>
            {/* Header */}
            <header style={styles.header}>
                <div style={styles.headerLeft}>
                    <h1 style={styles.title}>How's My Heart</h1>
                </div>
                <div style={styles.headerRight}>
                    {port ? (
                        <div style={styles.buttonGroup}>
                            <button onClick={disconnectSerial} style={styles.disconnectBtn}>
                                Disconnect
                            </button>
                            {sessionComplete && (
                                <button onClick={resetSession} style={styles.connectBtn}>
                                    Test Again
                                </button>
                            )}
                        </div>
                    ) : (
                        <button
                            onClick={connectSerial}
                            style={{
                                ...styles.connectBtn,
                                opacity: connecting ? 0.8 : 1
                            }}
                            disabled={connecting}
                        >
                            {connecting && (
                                <svg style={styles.spinnerIcon} viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4 31.4" />
                                </svg>
                            )}
                            {connecting ? 'Connecting...' : 'Connect'}
                        </button>
                    )}
                </div>
            </header>

            {/* Main Content */}
            <main style={styles.main}>
                <div style={styles.contentRow}>
                    {/* Left Column - ECG Graph */}
                    <div style={styles.leftColumn}>
                        <div style={styles.ecgCard}>
                            {/* ECG Card Header */}
                            <div style={styles.ecgCardHeader}>
                                <div style={styles.ecgLeadLabel}>
                                    <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
                                        <path d="M1 8h3l2-6 3 12 2-6h8" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                    <span>Lead II</span>
                                </div>
                                <div style={styles.ecgStatus}>
                                    <span style={{
                                        ...styles.statusDot,
                                        backgroundColor: calibrating ? '#f59e0b' : (monitoringActive ? '#10b981' : (port ? '#6b7280' : '#9ca3af'))
                                    }}></span>
                                    <span style={styles.statusText}>
                                        {calibrating ? 'Calibrating' : (monitoringActive ? 'Recording' : (port ? 'Ready' : 'Standby'))}
                                    </span>
                                </div>
                            </div>

                            {/* Canvas */}
                            <div style={styles.canvasWrapper}>
                                <canvas ref={canvasRef} style={styles.canvas} />
                            </div>

                            {/* ECG Card Footer */}
                            <div style={styles.ecgCardFooter}>
                                <span style={styles.ecgFooterText}>25mm/s • 10mm/mV</span>
                                <span style={styles.ecgFooterText}>Paper Speed: Standard</span>
                            </div>
                        </div>

                        {/* Advanced Cardiac Metrics Panel (Replaces old Health Panel) */}
                        {(sessionComplete && healthMetrics) && (
                            <div style={styles.healthPanel}>
                                <div style={styles.healthHeader}>
                                    <h2 style={styles.healthTitle}>Cardiac Health Analysis</h2>
                                    <div style={{
                                        ...styles.scoreBadge,
                                        backgroundColor: healthMetrics.score >= 80 ? '#22c55e' : (healthMetrics.score >= 60 ? '#f59e0b' : '#ef4444')
                                    }}>
                                        Score: {Math.round(healthMetrics.score)}
                                    </div>
                                </div>

                                <div style={styles.metricsGrid}>
                                    {/* 2. SDNN */}
                                    <div
                                        style={{ ...styles.metricCard, position: 'relative' }}
                                        onMouseEnter={() => setHoveredMetric('SDNN')}
                                        onMouseLeave={() => setHoveredMetric(null)}
                                    >
                                        {hoveredMetric === 'SDNN' && <div style={styles.tooltip}>{metricExplanations.SDNN}</div>}
                                        <div style={styles.metricLabel}>SDNN (HRV)</div>
                                        <div style={styles.metricValue}>{Math.round(healthMetrics.sdnn)} <span style={styles.metricUnit}>ms</span></div>
                                        <div style={{
                                            ...styles.metricZone,
                                            color: healthMetrics.sdnn > 100 ? '#22c55e' : (healthMetrics.sdnn >= 50 ? '#22c55e' : (healthMetrics.sdnn >= 30 ? '#f59e0b' : '#ef4444'))
                                        }}>
                                            {healthMetrics.sdnn > 100 ? 'Excellent' : (healthMetrics.sdnn >= 50 ? 'Normal' : (healthMetrics.sdnn >= 30 ? 'Moderate' : 'High Risk'))}
                                        </div>
                                    </div>

                                    {/* 3. RMSSD */}
                                    <div
                                        style={{ ...styles.metricCard, position: 'relative' }}
                                        onMouseEnter={() => setHoveredMetric('RMSSD')}
                                        onMouseLeave={() => setHoveredMetric(null)}
                                    >
                                        {hoveredMetric === 'RMSSD' && <div style={styles.tooltip}>{metricExplanations.RMSSD}</div>}
                                        <div style={styles.metricLabel}>RMSSD</div>
                                        <div style={styles.metricValue}>{Math.round(healthMetrics.rmssd)} <span style={styles.metricUnit}>ms</span></div>
                                        <div style={{
                                            ...styles.metricZone,
                                            color: healthMetrics.rmssd > 50 ? '#22c55e' : (healthMetrics.rmssd >= 30 ? '#22c55e' : (healthMetrics.rmssd >= 20 ? '#f59e0b' : '#ef4444'))
                                        }}>
                                            {healthMetrics.rmssd > 50 ? 'Excellent' : (healthMetrics.rmssd >= 30 ? 'Normal' : (healthMetrics.rmssd >= 20 ? 'Moderate' : 'High Risk'))}
                                        </div>
                                    </div>

                                    {/* 4. pNN50 */}
                                    <div
                                        style={{ ...styles.metricCard, position: 'relative' }}
                                        onMouseEnter={() => setHoveredMetric('pNN50')}
                                        onMouseLeave={() => setHoveredMetric(null)}
                                    >
                                        {hoveredMetric === 'pNN50' && <div style={styles.tooltip}>{metricExplanations.pNN50}</div>}
                                        <div style={styles.metricLabel}>pNN50</div>
                                        <div style={styles.metricValue}>{Math.round(healthMetrics.pnn50)}<span style={styles.metricUnit}>%</span></div>
                                        <div style={{
                                            ...styles.metricZone,
                                            color: healthMetrics.pnn50 > 20 ? '#22c55e' : (healthMetrics.pnn50 >= 10 ? '#f59e0b' : '#ef4444')
                                        }}>
                                            {healthMetrics.pnn50 > 20 ? 'Healthy' : (healthMetrics.pnn50 >= 10 ? 'Moderate' : 'Irregular')}
                                        </div>
                                    </div>

                                    {/* 5. IRR Index */}
                                    <div
                                        style={{ ...styles.metricCard, position: 'relative' }}
                                        onMouseEnter={() => setHoveredMetric('IRR')}
                                        onMouseLeave={() => setHoveredMetric(null)}
                                    >
                                        {hoveredMetric === 'IRR' && <div style={styles.tooltip}>{metricExplanations.IRR}</div>}
                                        <div style={styles.metricLabel}>IRR Index</div>
                                        <div style={styles.metricValue}>{healthMetrics.irr.toFixed(3)}</div>
                                        <div style={{
                                            ...styles.metricZone,
                                            color: healthMetrics.irr < 0.05 ? '#22c55e' : (healthMetrics.irr <= 0.12 ? '#f59e0b' : '#ef4444')
                                        }}>
                                            {healthMetrics.irr < 0.05 ? 'Regular' : (healthMetrics.irr <= 0.12 ? 'Moderate' : 'AFib Risk')}
                                        </div>
                                    </div>

                                    {/* 7. SD1 */}
                                    <div
                                        style={{ ...styles.metricCard, position: 'relative' }}
                                        onMouseEnter={() => setHoveredMetric('SD1')}
                                        onMouseLeave={() => setHoveredMetric(null)}
                                    >
                                        {hoveredMetric === 'SD1' && <div style={styles.tooltip}>{metricExplanations.SD1}</div>}
                                        <div style={styles.metricLabel}>Poincaré SD1</div>
                                        <div style={styles.metricValue}>{Math.round(healthMetrics.sd1)} <span style={styles.metricUnit}>ms</span></div>
                                        <div style={{
                                            ...styles.metricZone,
                                            color: healthMetrics.sd1 > 40 ? '#22c55e' : (healthMetrics.sd1 >= 20 ? '#f59e0b' : '#ef4444')
                                        }}>
                                            {healthMetrics.sd1 > 40 ? 'Healthy' : (healthMetrics.sd1 >= 20 ? 'Moderate' : 'High Risk')}
                                        </div>
                                    </div>

                                    {/* AFib Decision */}
                                    <div
                                        style={{
                                            ...styles.metricCard,
                                            gridColumn: 'span 2',
                                            backgroundColor: healthMetrics.isAfibRisk ? '#fef2f2' : '#f0fdf4',
                                            borderColor: healthMetrics.isAfibRisk ? '#ef4444' : '#22c55e',
                                            position: 'relative'
                                        }}
                                        onMouseEnter={() => setHoveredMetric('AFib')}
                                        onMouseLeave={() => setHoveredMetric(null)}
                                    >
                                        {hoveredMetric === 'AFib' && <div style={styles.tooltip}>{metricExplanations.AFib}</div>}
                                        <div style={styles.metricLabel}>AFib Decision Rule</div>
                                        <div style={{
                                            fontSize: '14px',
                                            fontWeight: '700',
                                            color: healthMetrics.isAfibRisk ? '#dc2626' : '#16a34a'
                                        }}>
                                            {healthMetrics.isAfibRisk ? 'HIGH RISK DETECTED' : 'LOW RISK / NORMAL'}
                                        </div>
                                    </div>
                                </div>


                                {/* Score Interpretation Block */}
                                <div style={styles.scoreLegend}>
                                    <div style={styles.scoreLegendTitle}>Understanding Your Health Score</div>
                                    <div style={styles.scoreLegendGrid}>
                                        <div style={styles.scoreLegendItem}>
                                            <span style={{ ...styles.scoreLegendLabel, color: '#22c55e' }}>80 - 100 (Excellent)</span>
                                            <div style={styles.scoreLegendDesc}>High HRV indicates a healthy, resilient nervous system and low stress.</div>
                                        </div>
                                        <div style={styles.scoreLegendItem}>
                                            <span style={{ ...styles.scoreLegendLabel, color: '#eab308' }}>60 - 79 (Moderate)</span>
                                            <div style={styles.scoreLegendDesc}>Average variability. Typical for mild stress or fatigue.</div>
                                        </div>
                                        <div style={styles.scoreLegendItem}>
                                            <span style={{ ...styles.scoreLegendLabel, color: '#ef4444' }}>&lt; 60 (Needs Attention)</span>
                                            <div style={styles.scoreLegendDesc}>Low adaptability or potential arrhythmia. High stress burden.</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Right Column - Stats Panel */}
                    <div style={styles.rightColumn}>
                        {/* Heart Rate Circle */}
                        {/* Wavy BPM Card */}
                        <div style={styles.waveCard}>
                            <div style={styles.waveContainer}>
                                {/* Wave Animations */}
                                <div style={{
                                    ...styles.waveWrapper,
                                    color: (bpm || 0) < 60 ? '#22c55e' : ((bpm || 0) < 100 ? '#22c55e' : ((bpm || 0) < 120 ? '#eab308' : '#ef4444'))
                                }}>
                                    {/* Wave 1 - Outer */}
                                    <div style={{
                                        ...styles.wave,
                                        width: '100%', height: '100%',
                                        animation: 'spinWave 10s linear infinite',
                                        borderRadius: '40% 60% 70% 30% / 40% 50% 60% 50%',
                                        opacity: 0.1,
                                        backgroundColor: 'currentColor',
                                    }} />
                                    {/* Wave 2 - Middle */}
                                    <div style={{
                                        ...styles.wave,
                                        width: '85%', height: '85%',
                                        animation: 'spinWaveReverse 8s linear infinite',
                                        borderRadius: '60% 40% 30% 70% / 60% 30% 70% 40%',
                                        opacity: 0.2,
                                        backgroundColor: 'currentColor',
                                    }} />
                                    {/* Wave 3 - Inner */}
                                    <div style={{
                                        ...styles.wave,
                                        width: '70%', height: '70%',
                                        animation: 'spinWave 6s linear infinite',
                                        borderRadius: '45% 55% 45% 55% / 55% 45% 55% 45%',
                                        opacity: 0.3,
                                        backgroundColor: 'currentColor',
                                    }} />

                                    {/* Central Circle */}
                                    <div style={styles.waveCenter}>
                                        <div style={styles.waveValue}>
                                            {bpm || '--'}
                                        </div>
                                        <div style={styles.waveLabel}>
                                            LIVE BPM
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Status Information Below Circle */}
                            <div style={styles.statusContainer}>
                                <div style={styles.bpmStatusDark}>
                                    <span style={{
                                        ...styles.statusDotSmall,
                                        backgroundColor: calibrating ? '#f59e0b' : (monitoringActive ? '#22c55e' : (sessionComplete ? '#3b82f6' : '#9ca3af'))
                                    }}></span>
                                    <span>
                                        {calibrating ? 'Calibrating (4s)' :
                                            (monitoringActive ? `Recording (${15 - sessionTime}s)` :
                                                (sessionComplete ? 'Session Complete' : 'Ready'))}
                                    </span>
                                </div>
                                {resultStatus && (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                                        <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1f2937' }}>
                                            Avg: {averageBpm} BPM
                                        </div>
                                        <div style={{ ...styles.resultText, color: resultStatus.color, margin: 0 }}>
                                            {resultStatus.label}: {resultStatus.meaning}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Stats Grid - Square Cards */}
                        <div style={styles.statsGrid}>
                            {/* Samples Card */}
                            <div style={styles.statCard}>
                                <div style={styles.statHeaderCentered}>
                                    <span style={styles.statLabel}>SAMPLES</span>
                                    <svg style={styles.statIcon} viewBox="0 0 24 24" fill="none">
                                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                </div>
                                <div style={styles.statValue}>{samplesRef.current.length || '--'}</div>
                            </div>

                            {/* Session Time Card */}
                            <div style={styles.statCard}>
                                <div style={styles.statHeaderCentered}>
                                    <span style={styles.statLabel}>TIME</span>
                                    <svg style={styles.statIcon} viewBox="0 0 24 24" fill="none">
                                        <circle cx="12" cy="12" r="10" stroke="#ec4899" strokeWidth="2" />
                                        <path d="M12 6v6l4 2" stroke="#ec4899" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                </div>
                                <div style={styles.statValue}>{sessionTime}s</div>
                            </div>

                            {/* Lead Type Card */}
                            <div style={styles.statCard}>
                                <div style={styles.statHeaderCentered}>
                                    <span style={styles.statLabel}>LEAD</span>
                                    <svg style={styles.statIcon} viewBox="0 0 24 24" fill="none">
                                        <rect x="3" y="3" width="18" height="18" rx="2" stroke="#ef4444" strokeWidth="2" />
                                        <path d="M3 9h18M9 21V9" stroke="#ef4444" strokeWidth="2" />
                                    </svg>
                                </div>
                                <div style={styles.statValue}>II</div>
                            </div>
                        </div>
                    </div>
                </div>


            </main >
        </div >
    );
}

// Styles
const styles = {
    container: {
        minHeight: '100vh',
        backgroundColor: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '20px 32px',
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e5e7eb',
    },
    headerLeft: {
        display: 'flex',
        flexDirection: 'column',
    },
    title: {
        margin: 0,
        fontSize: '22px',
        fontWeight: 700,
        color: '#1f2937',
    },
    subtitle: {
        margin: '4px 0 0 0',
        fontSize: '13px',
        color: '#6b7280',
    },
    headerRight: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
    },
    buttonGroup: {
        display: 'flex',
        gap: '12px',
    },
    connectBtn: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 28px',
        fontSize: '14px',
        fontWeight: 600,
        color: '#ffffff',
        backgroundColor: '#10b981',
        border: 'none',
        borderRadius: '50px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
    },
    disconnectBtn: {
        padding: '12px 28px',
        fontSize: '14px',
        fontWeight: 600,
        color: '#6b7280',
        backgroundColor: '#f3f4f6',
        border: '1px solid #e5e7eb',
        borderRadius: '50px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
    },
    spinnerIcon: {
        width: '16px',
        height: '16px',
        animation: 'spinLoader 1s linear infinite',
    },
    main: {
        padding: '32px 48px', // Increased padding for window margin look
        maxWidth: '1400px', // Allow more width
        margin: '0 auto',
    },
    contentRow: {
        display: 'flex',
        gap: '32px', // increased gap
        marginBottom: '24px',
    },
    leftColumn: {
        flex: '0 0 60%',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
    },
    rightColumn: {
        flex: '1',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
    },
    ecgCard: {
        borderRadius: '16px',
        overflow: 'hidden',
        border: '1px solid #e5e7eb',
        backgroundColor: '#ffffff',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    },
    ecgCardHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 20px',
        borderBottom: '1px solid #f3f4f6',
    },
    ecgLeadLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        fontSize: '15px',
        fontWeight: 600,
        color: '#1f2937',
    },
    ecgStatus: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
    },
    statusDot: {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
    },
    statusText: {
        fontSize: '13px',
        color: '#6b7280',
    },
    canvasWrapper: {
        padding: '0',
    },
    canvas: {
        width: '100%',
        display: 'block',
    },
    ecgCardFooter: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 20px',
        borderTop: '1px solid #f3f4f6',
        backgroundColor: '#fafafa',
    },
    ecgFooterText: {
        fontSize: '12px',
        color: '#9ca3af',
    },
    waveCard: {
        backgroundColor: '#ffffff',
        borderRadius: '24px',
        border: '1px solid #e5e7eb',
        padding: '24px',
        textAlign: 'center',
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.05)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        width: '300px', // Perfect square width
        height: '300px', // Perfect square height
        margin: '0 auto',
    },
    waveContainer: {
        position: 'relative',
        width: '160px',
        height: '160px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '16px',
    },
    waveWrapper: {
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'color 1s ease',
    },
    wave: {
        position: 'absolute',
        transition: 'all 0.5s ease',
    },
    waveCenter: {
        position: 'absolute',
        zIndex: 10,
        backgroundColor: '#ffffff',
        width: '90px',
        height: '90px',
        borderRadius: '50%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 15px rgba(0,0,0,0.05)',
        border: '1px solid #f3f4f6',
    },
    waveValue: {
        fontSize: '32px',
        fontWeight: 700,
        color: '#1f2937',
        lineHeight: 1,
    },
    waveLabel: {
        fontSize: '12px',
        color: '#9ca3af',
        marginTop: '2px',
        fontWeight: 600,
    },
    statusContainer: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        marginTop: '8px',
    },
    statsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', // Auto layout
        gap: '16px',
        width: '100%',
    },
    statCard: {
        backgroundColor: '#ffffff',
        borderRadius: '20px',
        border: '1px solid #e5e7eb',
        padding: '16px',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.04)',
        aspectRatio: '1 / 1', // Force Square
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
    },
    statHeaderCentered: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '4px',
    },
    statHeader: {
        display: 'none', // Deprecated
    },
    bpmStatusDark: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        fontSize: '13px',
        color: '#6b7280',
        backgroundColor: '#f3f4f6',
        padding: '6px 12px',
        borderRadius: '20px',
        marginBottom: '4px',
        width: 'fit-content',
    },
    resultText: {
        fontSize: '13px',
        fontWeight: 600,
        marginTop: '6px',
    },
    // Keep spin keyframes global or use a style tag for it if needed

    statusDotSmall: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
    },
    statCard: {
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        padding: '16px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    },
    statHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
    },
    statLabel: {
        fontSize: '11px',
        fontWeight: 600,
        color: '#6b7280',
        letterSpacing: '0.5px',
    },
    statIcon: {
        width: '18px',
        height: '18px',
    },
    statValue: {
        fontSize: '24px',
        fontWeight: 700,
        color: '#1f2937',
    },
    statUnit: {
        fontSize: '14px',
        fontWeight: 400,
        color: '#9ca3af',
    },
    healthPanel: {
        marginTop: '24px',
        backgroundColor: '#ffffff',
        borderRadius: '16px',
        padding: '24px',
        border: '1px solid #e5e7eb',
        boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
    },
    healthHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px',
    },
    healthTitle: {
        fontSize: '18px',
        fontWeight: '700',
        color: '#111827',
        margin: 0,
    },
    scoreBadge: {
        padding: '6px 12px',
        borderRadius: '20px',
        color: '#fff',
        fontWeight: 'bold',
        fontSize: '14px',
    },
    metricsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '16px',
    },
    metricCard: {
        backgroundColor: '#f9fafb',
        borderRadius: '12px',
        padding: '12px',
        border: '1px solid #f3f4f6',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
    },
    metricLabel: {
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: '#6b7280',
        marginBottom: '4px',
        fontWeight: '600',
    },
    metricValue: {
        fontSize: '18px',
        fontWeight: '800',
        color: '#1f2937',
        marginBottom: '2px',
    },
    metricUnit: {
        fontSize: '10px',
        fontWeight: 'normal',
        color: '#9ca3af',
    },
    metricZone: {
        fontSize: '11px',
        fontWeight: '600',
        marginTop: 'auto',
    },
    tooltip: {
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: '#1f2937',
        color: '#ffffff',
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '11px',
        lineHeight: '1.4',
        width: '180px',
        zIndex: 50,
        marginBottom: '8px',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        pointerEvents: 'none',
        textAlign: 'center',
    },
    scoreLegend: {
        marginTop: '20px',
        borderTop: '1px solid #e5e7eb',
        paddingTop: '16px',
        fontSize: '12px',
    },
    scoreLegendTitle: {
        fontWeight: '700',
        color: '#374151',
        marginBottom: '12px',
        fontSize: '13px',
    },
    scoreLegendGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '12px',
    },
    scoreLegendItem: {
        backgroundColor: '#f9fafb',
        padding: '12px',
        borderRadius: '8px',
        border: '1px solid #f3f4f6',
    },
    scoreLegendLabel: {
        fontWeight: '700',
        marginBottom: '4px',
        display: 'block',
        fontSize: '12px',
    },
    scoreLegendDesc: {
        color: '#6b7280',
        fontSize: '11px',
        lineHeight: '1.4',
    },
};
