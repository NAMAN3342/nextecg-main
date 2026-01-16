import React, { useEffect, useRef } from 'react'

/**
 * 2D Vectorcardiogram Component
 * Displays the frontal plane VCG loop using Lead I (X) and aVF (Y)
 * Shows real-time cardiac vector rotation
 */
export default function VectorCardiogram({ leadData, sampleRate = 125, gain = 1.0 }) {
    const canvasRef = useRef(null)
    const CANVAS_SIZE = 280
    const GRID_SIZE = 240
    const CENTER = CANVAS_SIZE / 2
    const SCALE = 40 // pixels per mV

    // Store recent samples for drawing the loop
    const historyLength = Math.floor(sampleRate * 0.8) // ~0.8 seconds for one cardiac cycle

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        canvas.width = CANVAS_SIZE
        canvas.height = CANVAS_SIZE

        drawVCG(ctx)
    }, [leadData, gain])

    function drawVCG(ctx) {
        // Clear canvas
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

        // Draw grid background
        drawGrid(ctx)

        // Draw axes
        drawAxes(ctx)

        // Draw VCG loop if we have data
        if (leadData && leadData.leadI && leadData.aVF) {
            drawLoop(ctx, leadData.leadI, leadData.aVF)
        }
    }

    function drawGrid(ctx) {
        const gridSpacing = 20 // 20px = 0.5mV

        // Minor grid
        ctx.strokeStyle = 'rgba(239, 83, 80, 0.2)'
        ctx.lineWidth = 0.5
        for (let i = gridSpacing; i < CANVAS_SIZE; i += gridSpacing) {
            ctx.beginPath()
            ctx.moveTo(i, 0)
            ctx.lineTo(i, CANVAS_SIZE)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(0, i)
            ctx.lineTo(CANVAS_SIZE, i)
            ctx.stroke()
        }

        // Major grid (every 5 minor = 2.5mV)
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.4)'
        ctx.lineWidth = 1
        const majorSpacing = gridSpacing * 5
        for (let i = majorSpacing; i < CANVAS_SIZE; i += majorSpacing) {
            ctx.beginPath()
            ctx.moveTo(i, 0)
            ctx.lineTo(i, CANVAS_SIZE)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(0, i)
            ctx.lineTo(CANVAS_SIZE, i)
            ctx.stroke()
        }
    }

    function drawAxes(ctx) {
        // Center crosshair axes
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)'
        ctx.lineWidth = 1.5

        // Horizontal axis (Lead I: Right ← → Left)
        ctx.beginPath()
        ctx.moveTo(20, CENTER)
        ctx.lineTo(CANVAS_SIZE - 20, CENTER)
        ctx.stroke()

        // Arrow for X-axis
        ctx.beginPath()
        ctx.moveTo(CANVAS_SIZE - 20, CENTER)
        ctx.lineTo(CANVAS_SIZE - 28, CENTER - 4)
        ctx.lineTo(CANVAS_SIZE - 28, CENTER + 4)
        ctx.closePath()
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
        ctx.fill()

        // Vertical axis (aVF: Superior ↑ ↓ Inferior)
        ctx.beginPath()
        ctx.moveTo(CENTER, 20)
        ctx.lineTo(CENTER, CANVAS_SIZE - 20)
        ctx.stroke()

        // Arrow for Y-axis (pointing down = inferior)
        ctx.beginPath()
        ctx.moveTo(CENTER, CANVAS_SIZE - 20)
        ctx.lineTo(CENTER - 4, CANVAS_SIZE - 28)
        ctx.lineTo(CENTER + 4, CANVAS_SIZE - 28)
        ctx.closePath()
        ctx.fill()

        // Axis labels
        ctx.font = 'bold 11px Inter, system-ui, sans-serif'
        ctx.fillStyle = '#1e40af'
        ctx.textAlign = 'center'

        // Lead I labels
        ctx.fillText('Left (+)', CANVAS_SIZE - 35, CENTER - 10)
        ctx.fillText('Right (-)', 35, CENTER - 10)

        // aVF labels
        ctx.fillText('Superior (-)', CENTER, 16)
        ctx.fillText('Inferior (+)', CENTER, CANVAS_SIZE - 8)

        // Origin label
        ctx.fillStyle = '#dc2626'
        ctx.font = 'bold 10px Inter, system-ui, sans-serif'
        ctx.fillText('0', CENTER - 12, CENTER - 8)
    }

    function drawLoop(ctx, leadI, aVF) {
        if (!leadI || !aVF || leadI.length === 0) return

        const len = Math.min(leadI.length, aVF.length, historyLength)
        if (len < 2) return

        // Get the most recent samples
        const startIdx = Math.max(0, leadI.length - len)

        // Draw the VCG loop with color gradient (older = faded, newer = bright)
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        for (let i = 1; i < len; i++) {
            const idx = startIdx + i
            const prevIdx = startIdx + i - 1

            // Convert mV to pixels
            // X: Lead I (+ = left = positive X direction)
            // Y: aVF (+ = inferior = positive Y direction, but canvas Y is inverted)
            const x1 = CENTER + (leadI[prevIdx] * SCALE * gain)
            const y1 = CENTER + (aVF[prevIdx] * SCALE * gain) // Note: positive aVF goes DOWN
            const x2 = CENTER + (leadI[idx] * SCALE * gain)
            const y2 = CENTER + (aVF[idx] * SCALE * gain)

            // Color gradient: older samples are more transparent
            const progress = i / len
            const alpha = 0.2 + (progress * 0.8)

            // Color based on time in cardiac cycle
            // QRS complex (early) = deep blue, T wave (later) = green
            const hue = 220 - (progress * 100) // Blue to teal
            ctx.strokeStyle = `hsla(${hue}, 80%, 45%, ${alpha})`

            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
        }

        // Draw current position marker (bright dot)
        if (len > 0) {
            const lastIdx = startIdx + len - 1
            const lastX = CENTER + (leadI[lastIdx] * SCALE * gain)
            const lastY = CENTER + (aVF[lastIdx] * SCALE * gain)

            // Outer glow
            ctx.beginPath()
            ctx.arc(lastX, lastY, 6, 0, Math.PI * 2)
            ctx.fillStyle = 'rgba(220, 38, 38, 0.3)'
            ctx.fill()

            // Inner dot
            ctx.beginPath()
            ctx.arc(lastX, lastY, 3, 0, Math.PI * 2)
            ctx.fillStyle = '#dc2626'
            ctx.fill()
        }
    }

    return (
        <div className="vcg-panel">
            <div className="vcg-header">
                <div className="vcg-title">
                    <span style={{ fontSize: '18px' }}>📊</span>
                    2D Vectorcardiogram
                </div>
                <div style={{ fontSize: '11px', color: '#718096' }}>
                    Frontal Plane (Lead I vs aVF)
                </div>
            </div>
            <div className="vcg-canvas-container">
                <canvas
                    ref={canvasRef}
                    style={{
                        width: CANVAS_SIZE,
                        height: CANVAS_SIZE,
                        borderRadius: '8px',
                        border: '1px solid #e2e8f0'
                    }}
                />
            </div>
            <div style={{
                marginTop: '10px',
                fontSize: '11px',
                color: '#718096',
                textAlign: 'center'
            }}>
                <span style={{ color: '#1e40af', fontWeight: '600' }}>●</span> QRS Loop &nbsp;
                <span style={{ color: '#059669', fontWeight: '600' }}>●</span> T Loop &nbsp;
                <span style={{ color: '#dc2626', fontWeight: '600' }}>●</span> Current Vector
            </div>
        </div>
    )
}
