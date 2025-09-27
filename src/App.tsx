import {useState, type ChangeEvent, useRef, type MouseEvent, useEffect, useCallback} from 'react';
import './App.css';
import Tesseract from 'tesseract.js';
import cvReadyPromise from "@techstark/opencv-js";

const getLevenshteinDistance = (a: string, b: string): number => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) {
        matrix[0][i] = i;
    }

    for (let j = 0; j <= b.length; j++) {
        matrix[j][0] = j;
    }

    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1, // deletion
                matrix[j - 1][i] + 1, // insertion
                matrix[j - 1][i - 1] + substitutionCost // substitution
            );
        }
    }

    return matrix[b.length][a.length];
};

const getMostFrequent = (arr: string[]): string => {
    if (!arr || arr.length === 0) return '';
    const counts = arr.reduce((acc, value) => {
        acc[value] = (acc[value] || 0) + 1;
        return acc;
    }, {} as { [key: string]: number });
    return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
};

interface SelectionRect {
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    threshold: number;
    scaleX: number;
    scaleY: number;
    negative: boolean;
    x2?: number;
    y2?: number;
    width2?: number;
    height2?: number;
}

const defaultSelection: SelectionRect = {
    label: '',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    threshold: 150,
    scaleX: 3,
    scaleY: 5,
    negative: true,
};

const defaultSelections: SelectionRect[] = [
    {
        label: 'TITLE',
        x: 45,
        y: 580,
        width: 859,
        height: 42,
        scaleX: 1,
        scaleY: 1,
        threshold: 120,
    },
    {
        label: 'ARTIST',
        x: 45,
        y: 580,
        width: 859,
        height: 42,
        scaleX: 1,
        scaleY: 1,
        threshold: 160,
    },
    {
        label: 'DIFFICULTY',
        x: 980,
        y: 480,
        width: 150,
        height: 25,
        threshold: 120,
    },
    {
        label: 'NOTES',
        x: 213,
        y: 519,
        width: 70,
        height: 25,
        x2: 285,
        y2: 519,
        width2: 45,
        height2: 25,
    },
    {
        label: 'CHORD',
        x: 558,
        y: 520,
        width: 65,
        height: 24,
        x2: 625,
        y2: 520,
        width2: 45,
        height2: 24,
    },
    {
        label: 'PEAK',
        x: 902,
        y: 521,
        width: 65,
        height: 24,
        x2: 970,
        y2: 521,
        width2: 45,
        height2: 24,
    },
    {
        label: 'CHARGE',
        x: 212,
        y: 543,
        width: 70,
        height: 24,
        x2: 285,
        y2: 543,
        width2: 45,
        height2: 24,
    },
    {
        label: 'SCRATCH',
        x: 558,
        y: 545,
        width: 65,
        height: 21,
        x2: 625,
        y2: 545,
        width2: 45,
        height2: 21,
    },
    {
        label: 'SOF-LAN',
        x: 901,
        y: 545,
        width: 65,
        height: 22,
        x2: 970,
        y2: 545,
        width2: 45,
        height2: 22,
    },
].map(e => ({...defaultSelection, ...e,}))

const defaultPerspectivePoints = [
    {x: 644, y: 66},
    {x: 1580, y: 33},
    {x: 1708, y: 1000},
    {x: 600, y: 1006},
]

type outputData = {
    musicId: number;
    playStyle: number;
    difficulty: number;
    notes: number;
    chord: number;
    peak: number;
    charge: number;
    scratch: number;
    soflan: number;
}

export function App() {
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [capturedImage, setCapturedImage] = useState<ImageData | null>(null);
    const [frameRate, setFrameRate] = useState(60);

    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
    const [endPoint, setEndPoint] = useState<{ x: number; y: number } | null>(null);
    const [selections, setSelections] = useState<SelectionRect[]>(defaultSelections);
    const [ocrResults, setOcrResults] = useState<string[]>([]);
    const [selectedCorrections, setSelectedCorrections] = useState<(string | null)[]>([]);
    const [selectedCorrectionIds, setSelectedCorrectionIds] = useState<(number | null)[]>([]);
    const [correctionSuggestions, setCorrectionSuggestions] = useState<Array<Array<{
        title: string,
        artist: string,
        id: number,
        distance: number,
        titleDistance: number,
        artistDistance: number,
    }>>>([]);
    const [isOcrRunning, setIsOcrRunning] = useState(false);
    const [processedImages, setProcessedImages] = useState<{ integer: string, decimal?: string }[]>([]);
    const [redrawTarget, setRedrawTarget] = useState<{ index: number, part: 'integer' | 'decimal' } | null>(null);
    const [isSeeking, setIsSeeking] = useState(false);
    const [skipFramesAfterChange, setSkipFramesAfterChange] = useState(3);
    const [autoOcrAfterChange, setAutoOcrAfterChange] = useState(true);
    const [shouldRunOcr, setShouldRunOcr] = useState(false);
    const [diffThreshold, setDiffThreshold] = useState(20);
    const [thresholdStep, setThresholdStep] = useState(3);
    const [ocrImageCount, setOcrImageCount] = useState(5);
    const isSeekingRef = useRef(false);

    const cvRef = useRef<any>(null);
    const [isCvReady, setIsCvReady] = useState(false);
    // State for perspective transform
    const [perspectivePoints, setPerspectivePoints] = useState<{ x: number, y: number }[]>(defaultPerspectivePoints);
    const [isSettingPerspective, setIsSettingPerspective] = useState(false);
    const [outputData, setOutputData] = useState<outputData[]>([]);

    const [playStyle, setPlayStyle] = useState(0);
    const [addOutputMessage, setAddOutputMessage] = useState('');
    const [addOutputMessageType, setAddOutputMessageType] = useState<'success' | 'error'>('success');
    const [correctionInputErrors, setCorrectionInputErrors] = useState<string[]>([]);
    const [showSelectionDetails, setShowSelectionDetails] = useState(true);

    // State for master data
    type MasterData = {
        title: string,
        artist: string,
        id: number,
    }
    const [titleMasterData, setTitleMasterData] = useState<MasterData[]>([]);
    const [showMasterDataInput, setShowMasterDataInput] = useState(true);
    const [masterDataJson, setMasterDataJson] = useState('');
    const [settingsJson, setSettingsJson] = useState('');


    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            setVideoSrc(url);
            setCapturedImage(null);
            setSelections(defaultSelections);
            setOcrResults([]);
            setSelectedCorrections([]);
            setSelectedCorrectionIds([]);
            setCorrectionInputErrors([]);
            setCorrectionSuggestions([]);
            setProcessedImages([]);
            setRedrawTarget(null);
            setIsSeeking(false);
            isSeekingRef.current = false;
            setShouldRunOcr(false);
            setPerspectivePoints(defaultPerspectivePoints);
            setOutputData([]);
            setPlayStyle(0);
            setIsSettingPerspective(false);
        }
    };

    const captureFrame = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const cv = cvRef.current;

        if (video && canvas && !video.paused) video.pause();
        if (video && canvas && cv) {
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (context) {
                // Draw video to a temporary canvas to get ImageData
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = video.videoWidth;
                tempCanvas.height = video.videoHeight;
                const tempCtx = tempCanvas.getContext('2d');
                if (!tempCtx) return;
                tempCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                const frameImageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);

                if (perspectivePoints.length === 4) {
                    // Apply perspective transform
                    const src = cv.matFromImageData(frameImageData);
                    const [tl, tr, br, bl] = perspectivePoints;
                    const widthA = Math.sqrt(Math.pow(br.x - bl.x, 2) + Math.pow(br.y - bl.y, 2));
                    const widthB = Math.sqrt(Math.pow(tr.x - tl.x, 2) + Math.pow(tr.y - tl.y, 2));
                    const maxWidth = Math.max(widthA, widthB);
                    const heightA = Math.sqrt(Math.pow(tr.x - br.x, 2) + Math.pow(tr.y - br.y, 2));
                    const heightB = Math.sqrt(Math.pow(tl.x - bl.x, 2) + Math.pow(tl.y - bl.y, 2));
                    const maxHeight = Math.max(heightA, heightB);

                    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
                    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight]);
                    const M = cv.getPerspectiveTransform(srcTri, dstTri);
                    const dsize = new cv.Size(maxWidth, maxHeight);
                    const warped = new cv.Mat();
                    cv.warpPerspective(src, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

                    canvas.width = maxWidth;
                    canvas.height = maxHeight;
                    cv.imshow(canvas, warped);
                    setCapturedImage(context.getImageData(0, 0, canvas.width, canvas.height));

                    src.delete();
                    M.delete();
                    srcTri.delete();
                    dstTri.delete();
                    warped.delete();
                } else {
                    // No transform, just use the original frame
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    context.putImageData(frameImageData, 0, 0);
                    setCapturedImage(frameImageData);
                }
                setOcrResults([]);
                setSelectedCorrections([]);
                setSelectedCorrectionIds([]);
                setCorrectionSuggestions([]);
                setProcessedImages([]);
            }
        }
    }, [perspectivePoints]);

    const getCanvasCoordinates = (event: MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return {x: 0, y: 0};
        const rect = canvas.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    };

    const handleMouseDown = (event: MouseEvent<HTMLCanvasElement>) => {
        if (!capturedImage) return;

        if (isSettingPerspective) {
            const pos = getCanvasCoordinates(event);
            setPerspectivePoints(prev => {
                const newPoints = [...prev, pos];
                // Reset if more than 4 points are clicked
                if (newPoints.length >= 4) {
                    setIsSettingPerspective(false);
                }
                return newPoints;
            });
            return;
        }
        if (redrawTarget === null) return;
        event.preventDefault();
        setIsDrawing(true);
        const pos = getCanvasCoordinates(event);
        setStartPoint(pos);
        setEndPoint(pos);
    };

    const handleMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
        if (!isDrawing) return;
        event.preventDefault();
        const pos = getCanvasCoordinates(event);
        setEndPoint(pos);
    };

    const handleMouseUp = (event: MouseEvent<HTMLCanvasElement>) => {
        if (!isDrawing || !startPoint || !endPoint) return;
        event.preventDefault();

        const newCoords = {
            x: Math.min(startPoint.x, endPoint.x),
            y: Math.min(startPoint.y, endPoint.y),
            width: Math.abs(endPoint.x - startPoint.x),
            height: Math.abs(endPoint.y - startPoint.y),
        };

        if (newCoords.width > 2 && newCoords.height > 2) {
            if (redrawTarget !== null) {
                const {index, part} = redrawTarget;
                setSelections(prev => prev.map((selection, i) => {
                    if (i === index) {
                        if (part === 'integer') {
                            return {...selection, ...newCoords};
                        } else {
                            return {...selection, x2: newCoords.x, y2: newCoords.y, width2: newCoords.width, height2: newCoords.height};
                        }
                    }
                    return selection;
                }));

                setRedrawTarget(null);
            }
        }

        setIsDrawing(false);
        setStartPoint(null);
        setEndPoint(null);
    };

    const handleRedraw = (index: number, part: 'integer' | 'decimal') => {
        setRedrawTarget({index, part});
    };

    const handleSettingPerspective = () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (video && canvas) {
            const context = canvas.getContext('2d');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context?.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
            setCapturedImage(context?.getImageData(0, 0, canvas.width, canvas.height) ?? null);
        }
        setPerspectivePoints([]);
        setIsSettingPerspective(true);
    }

    const handleLoadMasterData = () => {
        if (!masterDataJson.trim()) {
            alert('JSONデータを貼り付けてください。');
            return;
        }
        try {
            const data = (JSON.parse(masterDataJson)).data.music;
            // Basic validation: check if it's an array of strings
            if (Array.isArray(data) && data.every(item => typeof item === 'object')) {
                setTitleMasterData(data);
                setShowMasterDataInput(false);
                alert('マスタデータの読み込みに成功しました！');
            } else {
                alert('不正なJSONフォーマットです。');
            }
        } catch (error) {
            console.error('Failed to parse master data JSON:', error);
            alert('JSONの解析に失敗しました。フォーマットを確認してください。');
        }
    };

    const handleSelectionParamChange = (indexToChange: number, param: keyof SelectionRect, value: string | number | boolean) => {
        const updatedSelections = selections.map((selection, index) => {
            if (index === indexToChange) {
                return {...selection, [param]: value};
            }
            return selection;
        });
        setSelections(updatedSelections);
    };

    const handleExportSettings = () => {
        const settings = {
            perspectivePoints,
            detectionSettings: {
                diffThreshold,
                skipFramesAfterChange,
            },
            // Export all relevant properties, including optional ones
            selections: selections.map(({ label, x, y, width, height, threshold, scaleX, scaleY, negative, x2, y2, width2, height2 }) => ({
                label, x, y, width, height, threshold, scaleX, scaleY, negative, x2, y2, width2, height2
            })),
        };
        setSettingsJson(JSON.stringify(settings, null, 2));
        alert('現在の設定をエクスポートしました。');
    };

    const handleImportSettings = () => {
        if (!settingsJson.trim()) {
            alert('設定JSONを貼り付けてください。');
            return;
        }
        try {
            const settings = JSON.parse(settingsJson);

            if (settings.perspectivePoints && settings.detectionSettings && settings.selections) {
                setPerspectivePoints(settings.perspectivePoints);
                setDiffThreshold(settings.detectionSettings.diffThreshold);
                setSkipFramesAfterChange(settings.detectionSettings.skipFramesAfterChange);

                // Ensure imported selections have all default properties to prevent errors
                const importedSelections = settings.selections.map((importedRect: Partial<SelectionRect>) => ({
                    ...defaultSelection, // Start with defaults
                    ...importedRect,     // Override with imported values
                }));
                setSelections(importedSelections);

                alert('設定をインポートしました。');
                captureFrame(); // Apply new perspective settings
            } else {
                alert('不正なJSONフォーマットです。必要なキーが不足しています。');
            }
        } catch (error) {
            console.error('Failed to parse settings JSON:', error);
            alert('JSONの解析に失敗しました。フォーマットを確認してください。');
        }
    };

    const handleAddToOutput = useCallback(() => {
        const newErrors = Array(selections.length).fill('');

        const getCorrectionValue = (label: string): string | null => {
            const index = selections.findIndex(s => s.label === label);
            return index !== -1 ? selectedCorrections[index] : null;
        };

        const getCorrectionId = (label: string): number | null => {
            const index = selections.findIndex(s => s.label === label);
            return index !== -1 ? selectedCorrectionIds[index] : null;
        };

        const musicId = getCorrectionId('TITLE');
        const titleIndex = selections.findIndex(s => s.label === 'TITLE');
        if (musicId === null) {
            if (titleIndex !== -1) {
                newErrors[titleIndex] = 'TITLEが選択されていません。';
            }
        }

        // Validation for numeric fields
        const fieldsToValidate = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN'];
        const validatedValues: { [key: string]: number } = {};

        for (const label of fieldsToValidate) {
            const valueStr = getCorrectionValue(label);
            const value = parseFloat(valueStr || '0');
            const fieldIndex = selections.findIndex(s => s.label === label);

            if (fieldIndex !== -1 && (isNaN(value) || value < 0.00 || value > 200.00)) {
                newErrors[fieldIndex] = '0.00から200.00の間の数値を入力してください。';
            } else if (fieldIndex !== -1 && valueStr !== null && !(/^\d{1,3}\.\d{2}$/.test(valueStr))) {
                newErrors[fieldIndex] = 'XXX.XXの形式で入力してください。';
            } else {
                validatedValues[label.replace('-', '').toLowerCase()] = value;
            }
        }

        if (playStyle === 0) {
            alert('プレースタイルが選択されていません。');
            return;
        }

        if (newErrors.some(e => e !== '')) {
            setCorrectionInputErrors(newErrors);
            setTimeout(() => setCorrectionInputErrors(Array(selections.length).fill('')), 3000);
            return;
        }

        const difficultyValue = getCorrectionValue('DIFFICULTY');
        const difficultyMap: { [key: string]: number } = { 'B': 1, 'N': 2, 'H': 3, 'A': 4, 'L': 5 };
        const difficulty = difficultyValue ? difficultyMap[difficultyValue] : 0;
        if (difficulty === 0) {
            const diffIndex = selections.findIndex(s => s.label === 'DIFFICULTY');
            if (diffIndex !== -1) {
                newErrors[diffIndex] = '難易度が選択されていません。';
            }
        }

        const title = titleIndex !== -1 ? selectedCorrections[titleIndex] : '';

        // Check for duplicates
        if (outputData.some(item => item.musicId === musicId && item.difficulty === difficulty)) {
            setAddOutputMessageType('error');
            setAddOutputMessage(`${title} (${difficultyValue})は既に追加されています。`);
            setTimeout(() => setAddOutputMessage(''), 3000);
            return;
        }

        if(musicId === null){
            return;
        }

        const newOutput: outputData = {
            musicId: musicId,
            playStyle: playStyle,
            difficulty: difficulty,
            notes: validatedValues.notes,
            chord: validatedValues.chord,
            peak: validatedValues.peak,
            charge: validatedValues.charge,
            scratch: validatedValues.scratch,
            soflan: validatedValues.soflan,
        };

        setOutputData(prev => [...prev, newOutput].sort((a, b) => a.musicId - b.musicId));

        if (title) {
            setAddOutputMessageType('success');
            setAddOutputMessage(`${title} (${difficultyValue})を追加しました`);
            setTimeout(() => setAddOutputMessage(''), 3000);
        }
    }, [selections, playStyle, selectedCorrections, outputData, selectedCorrectionIds]);

    const findNextChange = useCallback(async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const cv = cvRef.current;
        if (!video || !canvas || !cv || selections.length === 0) return;

        const seekFrame = async () => {
            video.currentTime += (1 / frameRate);
            await new Promise(resolve => {
                const onSeeked = () => {
                    video.removeEventListener('seeked', onSeeked);
                    resolve(null);
                };
                video.addEventListener('seeked', onSeeked);
            });
        };

        // Get the whole canvas as a reference Mat
        const referenceMat = cv.imread(canvas);
        const referenceGray = new cv.Mat();
        cv.cvtColor(referenceMat, referenceGray, cv.COLOR_RGBA2GRAY);

        let changeDetected = false;
        while (isSeekingRef.current && !video.ended) {
            await seekFrame();

            if (!isSeekingRef.current) break;

            const currentMat = cv.imread(canvas);
            const currentGray = new cv.Mat();
            cv.cvtColor(currentMat, currentGray, cv.COLOR_RGBA2GRAY);

            const diff = new cv.Mat();
            cv.absdiff(referenceGray, currentGray, diff);

            const thresholdMat = new cv.Mat();
            cv.threshold(diff, thresholdMat, diffThreshold, 255, cv.THRESH_BINARY);

            changeDetected = selections.some(rect => {
                const roi = thresholdMat.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
                const nonZero = cv.countNonZero(roi);
                roi.delete();
                return nonZero > 10; // A small tolerance instead of > 0
            });

            currentMat.delete();
            currentGray.delete();
            diff.delete();
            thresholdMat.delete();

            if (changeDetected) {
                break;
            }
        }

        referenceMat.delete();
        referenceGray.delete();

        if (isSeekingRef.current && changeDetected) {
            // Skip frames to let the transition finish
            for (let i = 0; i < skipFramesAfterChange; i++) {
                if (!isSeekingRef.current || video.ended) break;
                await seekFrame();
            }

            if (isSeekingRef.current) { // Check again in case user stopped during skip
                captureFrame();
                if (autoOcrAfterChange) {
                    setShouldRunOcr(true);
                }
            }
        } else if (isSeekingRef.current) { // Stopped because video ended
            captureFrame();
        }
        setIsSeeking(false);
        isSeekingRef.current = false;
    }, [selections, frameRate, diffThreshold, captureFrame, skipFramesAfterChange, autoOcrAfterChange]);

    const handleDownloadJson = () => {
        if (outputData.length === 0) {
            alert('ダウンロードするデータがありません。');
            return;
        }
        const jsonString = JSON.stringify({data: outputData}, null, 2);
        const blob = new Blob([jsonString], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'output.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleSeek = useCallback((seconds: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime += seconds;
        }
    }, []);

    const runOCR = useCallback(async () => {
        if (!capturedImage || selections.length === 0 || isOcrRunning) return;

        setIsOcrRunning(true);
        setOcrResults(Array(selections.length).fill('Processing...'));

        const cv = cvRef.current;
        if (!cv) {
            setIsOcrRunning(false);
            return;
        }

        const fullSrcMat = cv.matFromImageData(capturedImage);

        const engWorker = await Tesseract.createWorker('eng', 1, {
            // logger: m => console.log(m),
        });
        await engWorker.setParameters({
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        });
        const jpnWorker = await Tesseract.createWorker('jpn', 1, {
            // logger: m => console.log(m),
        });
        await jpnWorker.setParameters({
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        });

        try {
            if (engWorker === null || jpnWorker === null) {
                return;
            }

            const generateUrlsWithVariations = (rect: SelectionRect, x: number, y: number, width: number, height: number): string[] => {
                if (!fullSrcMat || fullSrcMat.empty() || width <= 0 || height <= 0 || x + width > fullSrcMat.cols || y + height > fullSrcMat.rows) {
                    return [];
                }
                const urls: string[] = [];
                const centerIndex = Math.floor(ocrImageCount / 2);
                const thresholdVariations = [...Array(ocrImageCount)].map((_, i) => (i - centerIndex) * thresholdStep);
                let src = null;
                try {
                    src = fullSrcMat.roi(new cv.Rect(x, y, width, height));
                    for (const variation of thresholdVariations) {
                        let dst = null;
                        try {
                            dst = new cv.Mat();
                            const dsize = new cv.Size(Math.round(width * rect.scaleX), Math.round(height * rect.scaleY));
                            cv.resize(src, dst, dsize, 0, 0, cv.INTER_LANCZOS4);
                            cv.cvtColor(dst, dst, cv.COLOR_RGBA2GRAY, 0);
                            const thresholdType = rect.negative ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY;
                            const currentThreshold = rect.threshold + variation;
                            const clampedThreshold = Math.max(0, Math.min(255, currentThreshold));
                            cv.threshold(dst, dst, clampedThreshold, 255, thresholdType);
                            const tempCanvas = document.createElement('canvas');
                            cv.imshow(tempCanvas, dst);
                            urls.push(tempCanvas.toDataURL());
                        } finally {
                            dst?.delete();
                        }
                    }
                } finally {
                    src?.delete();
                }
                return urls;
            };

            const jobPromises: Promise<{ result: Tesseract.RecognizeResult, index: number, part: 'integer' | 'decimal', lang: 'eng' | 'jpn' }>[] = [];
            selections.forEach((rect, index) => {
                if (rect.label === 'DIFFICULTY') return; // Skip Tesseract for DIFFICULTY

                if (rect.label === 'TITLE' || rect.label === 'ARTIST') {
                    // For TITLE and ARTIST, run both jpn and eng workers
                    generateUrlsWithVariations(rect, rect.x, rect.y, rect.width, rect.height)
                        .forEach(url => {
                            jobPromises.push(jpnWorker.recognize(url).then(result => ({ result, index, part: 'integer', lang: 'jpn' })));
                            jobPromises.push(engWorker.recognize(url).then(result => ({ result, index, part: 'integer', lang: 'eng' })));
                        });
                } else {
                    // For other labels, run only eng worker
                    generateUrlsWithVariations(rect, rect.x, rect.y, rect.width, rect.height)
                        .forEach(url => jobPromises.push(engWorker.recognize(url).then(result => ({ result, index, part: 'integer', lang: 'eng' }))));

                    const isSplit = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN'].includes(rect.label);
                    if (isSplit && rect.x2 && rect.y2 && rect.width2 && rect.height2) {
                        generateUrlsWithVariations(rect, rect.x2, rect.y2, rect.width2, rect.height2)
                            .forEach(url => jobPromises.push(engWorker.recognize(url).then(result => ({ result, index, part: 'decimal', lang: 'eng' }))));
                    }
                }
            });

            const jobResults = await Promise.all(jobPromises);

            const finalResults = Array(selections.length).fill('');
            // This structure will hold arrays of results for voting
            const tempResults: { [key: number]: { integer?: { jpn?: string[], eng?: string[] }, decimal?: { jpn?: string[], eng?: string[] } } } = {};

            jobResults.forEach(job => {
                if (!tempResults[job.index]) tempResults[job.index] = {};
                if (!tempResults[job.index][job.part]) tempResults[job.index][job.part] = {};
                if (!tempResults[job.index][job.part]![job.lang]) tempResults[job.index][job.part]![job.lang] = [];

                let ocrText = job.result.data.text.trim();
                const selection = selections[job.index];

                if (selection.label === 'TITLE' || selection.label === 'ARTIST') {
                    ocrText = ocrText.replace(/(?<=[^ -~｡-ﾟ]) (?=[^ -~｡-ﾟ])/g, ''); // Remove spaces between full-width characters
                }
                tempResults[job.index][job.part]![job.lang]!.push(ocrText);
            });

            for (let i = 0; i < selections.length; i++) {
                const res = tempResults[i];
                if (res) {
                    const selection = selections[i];
                    if (selection.label === 'TITLE' || selection.label === 'ARTIST') {
                        // For TITLE/ARTIST, pass both results to the next step
                        finalResults[i] = {
                            jpn: res.integer?.jpn ? getMostFrequent(res.integer.jpn) : '',
                            eng: res.integer?.eng ? getMostFrequent(res.integer.eng) : '',
                        };
                    } else {
                        const finalInteger = res.integer?.eng ? getMostFrequent(res.integer.eng) : '';
                        const finalDecimal = res.decimal?.eng ? getMostFrequent(res.decimal.eng) : '';
                        finalResults[i] = (res.decimal !== undefined) ? `${finalInteger}.${finalDecimal}` : finalInteger;
                    }
                }
            }

            // --- Hue Calculation for DIFFICULTY ---
            const difficultyIndex = selections.findIndex(s => s.label === 'DIFFICULTY');
            if (difficultyIndex !== -1) {
                const rect = selections[difficultyIndex];
                let roi = null, hsv = null, mask = null, low = null, high = null;
                try {
                    if (rect.x + rect.width <= fullSrcMat.cols && rect.y + rect.height <= fullSrcMat.rows) {
                        roi = fullSrcMat.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
                        hsv = new cv.Mat();
                        cv.cvtColor(roi, hsv, cv.COLOR_RGBA2RGB);
                        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

                        mask = new cv.Mat();
                        low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, rect.threshold, 0, 0]);
                        high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 255, 255, 255]);
                        cv.inRange(hsv, low, high, mask);

                        const nonZeroPixels = cv.countNonZero(mask);
                        if (nonZeroPixels > 0) {
                            // --- More robust Hue detection by classifying each pixel ---
                            const targetHues = {
                                B: 69,
                                N: 102,
                                H: 20,
                                A: 0,
                                L: 136
                            };

                            const counts = { B: 0, N: 0, H: 0, A: 0, L: 0 };

                            for (let i = 0; i < hsv.rows; i++) {
                                for (let j = 0; j < hsv.cols; j++) {
                                    if (mask.ucharPtr(i, j)[0] !== 0) {
                                        const pixelHue = hsv.ucharPtr(i, j)[0];
                                        let minDistance = Infinity;
                                        let closestColor: keyof typeof counts = 'B';

                                        for (const [color, targetHue] of Object.entries(targetHues)) {
                                            const dist = Math.min(Math.abs(pixelHue - targetHue), 180 - Math.abs(pixelHue - targetHue));
                                            if (dist < minDistance) {
                                                minDistance = dist;
                                                closestColor = color as keyof typeof counts;
                                            }
                                        }
                                        counts[closestColor]++;
                                    }
                                }
                            }

                            const mostFrequentColor = Object.keys(counts).reduce((a, b) => counts[a as keyof typeof counts] > counts[b as keyof typeof counts] ? a : b);
                            finalResults[difficultyIndex] = mostFrequentColor;

                        } else {
                            finalResults[difficultyIndex] = "N/A";
                        }
                    }
                } finally {
                    roi?.delete(); hsv?.delete(); mask?.delete(); low?.delete(); high?.delete();
                }
            }

            setOcrResults(finalResults);

        } catch (error) {
            console.error('OCR Error:', error);
            setOcrResults(Array(selections.length).fill('Error'));
        } finally {
            fullSrcMat.delete();
            if (engWorker) await engWorker.terminate();
            if (jpnWorker) await jpnWorker.terminate();
            setIsOcrRunning(false);
        }
    }, [selections, isOcrRunning, capturedImage, ocrImageCount, thresholdStep]);

    useEffect(() => {
        if (shouldRunOcr && processedImages.length > 0 && !isOcrRunning) {
            runOCR();
            setShouldRunOcr(false);
        }
    }, [shouldRunOcr, processedImages, isOcrRunning, runOCR]);

    useEffect(() => {
        if (ocrResults.length === 0 || titleMasterData.length === 0) {
            setCorrectionSuggestions([]);
            setSelectedCorrectionIds([]);
            setSelectedCorrections([]);
            return;
        }

        const performSimpleCorrection = (text: string): string => {
            if (!text) return '';
            text = text
                .replace(/I/g, '1')
                .replace(/i/g, '1')
                .replace(/l/g, '1')
                .replace(/\|/g, '1')
                .replace(/!/g, '1')
                .replace(/]/g, '1')
                .replace(/e/g, '2')
                .replace(/Z/g, '2')
                .replace(/c/g, '2')
                .replace(/¢/g, '2')
                .replace(/A/g, '4')
                .replace(/q/g, '4')
                .replace(/y/g, '4')
                .replace(/a/g, '5')
                .replace(/S/g, '5')
                .replace(/s/g, '5')
                .replace(/H/g, '5')
                .replace(/b/g, '6')
                .replace(/G/g, '6')
                .replace(/B/g, '8')
                .replace(/Q/g, '9')
                .replace(/g/g, '9')
                .replace(/O/g, '0')
                .replace(/o/g, '0')
                .replace(/D/g, '0')
                .replace(/\.\./g, '.');

            text = text.replace(/[^0-9.]/g, "")

            if (text.indexOf(".") > 3 || Number(text) > 200) {
                let t = text.slice(0, text.indexOf("."))
                t = t.replace(/(\d)\1+/g, match => match.slice(0, -1))
                text = t + text.slice(text.indexOf("."), text.length)
            }

            if (text.slice(text.indexOf("."), text.length).length > 3) {
                let t = text.slice(text.indexOf("."), text.length)
                t = t.replace(/(\d)\1+/g, match => match.slice(0, -1))
                text = text.slice(0, text.indexOf(".")) + t
            }

            if (text.indexOf(".") > 3) {
                const length = text.indexOf(".")
                text = text.slice(length - 3)
            }

            if (text.slice(text.indexOf("."), text.length).length > 3) {
                text = text.slice(0, text.indexOf(".") + 3)
            }

            return text;
        };

        const newSuggestions: Array<Array<{
            title: string,
            artist: string,
            id: number,
            distance: number,
            titleDistance: number,
            artistDistance: number,
        }>> = Array.from({length: selections.length}, () => []);
        const newSelectedCorrections: (string | null)[] = Array(selections.length).fill(null);
        const newSelectedCorrectionIds: (number | null)[] = Array(selections.length).fill(null);

        // Find artist OCR result once
        const artistIndex = selections.findIndex(s => s.label === 'ARTIST');
        const artistOcrResult = artistIndex !== -1 ? ocrResults[artistIndex] : null;

        ocrResults.forEach((ocrText, index) => {
            const selectionLabel = selections[index]?.label;
            if (selectionLabel === 'DIFFICULTY') {
                newSelectedCorrections[index] = ocrText; // The result is the calculated hue value
            } else if (selectionLabel === 'TITLE' && titleMasterData.length > 0) {
                const titleOcrResult = ocrText; // This is now an object {jpn, eng}

                const suggestions = titleMasterData.map(masterItem => {
                    // @ts-expect-error ごめんね
                    const titleDistJpn = (titleOcrResult.jpn?.length > 0) ? getLevenshteinDistance(titleOcrResult.jpn, masterItem.title) : Infinity;
                    // @ts-expect-error ごめんね
                    const titleDistEng = (titleOcrResult.eng?.length > 0) ? getLevenshteinDistance(titleOcrResult.eng, masterItem.title) : Infinity;
                    const titleDist = (titleDistJpn < titleDistEng) ? titleDistJpn : titleDistEng;

                    // @ts-expect-error ごめんね
                    const artistDistJpn = (artistOcrResult?.jpn?.length > 0) ? getLevenshteinDistance(artistOcrResult.jpn, masterItem.artist) : Infinity;
                    // @ts-expect-error ごめんね
                    const artistDistEng = (artistOcrResult?.eng?.length > 0) ? getLevenshteinDistance(artistOcrResult.eng, masterItem.artist) : Infinity;
                    const artistDist = (artistDistJpn < artistDistEng) ? artistDistJpn : artistDistEng;

                    // Use the better of the two language results
                    const totalDistance = (titleDist === Infinity ? 0 : titleDist) + (artistDist === Infinity ? 0 : artistDist);

                    return {
                        title: masterItem.title,
                        artist: masterItem.artist,
                        id: masterItem.id,
                        distance: totalDistance,
                        titleDistance: titleDist,
                        artistDistance: artistDist,
                    };
                }).sort((a, b) => a.distance - b.distance).slice(0, 20);

                newSuggestions[index] = suggestions;
                newSelectedCorrections[index] = suggestions[0]?.title || ''; // Set best match as default
                newSelectedCorrectionIds[index] = suggestions[0]?.id ?? null;
            } else if (['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN'].includes(selectionLabel)) {
                newSelectedCorrections[index] = performSimpleCorrection(ocrText);
            }
        });

        setCorrectionSuggestions(newSuggestions);
        setSelectedCorrections(newSelectedCorrections);
        setSelectedCorrectionIds(newSelectedCorrectionIds);

    }, [ocrResults, titleMasterData, selections]);

    // Effect for Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) {
                return;
            }

            if (!videoSrc) return;

            switch (event.key.toLowerCase()) {
                case 'd':
                    handleSeek(-1);
                    break;
                case 'f':
                    handleSeek(-(1 / frameRate));
                    break;
                case 'j':
                    handleSeek(1 / frameRate);
                    break;
                case 'k':
                    handleSeek(1);
                    break;
                case 'l': {
                    const newIsSeeking = !isSeeking;
                    setIsSeeking(newIsSeeking);
                    isSeekingRef.current = newIsSeeking;
                    if (newIsSeeking) {
                        findNextChange();
                    }
                    break;
                }
                case 'enter':
                    event.preventDefault();
                    handleAddToOutput();
                    break;
                case ' ':
                    event.preventDefault();
                    runOCR();
                    break;
                default:
                    break;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [videoSrc, frameRate, handleSeek, runOCR, isSeeking, findNextChange, handleAddToOutput]);

    // Effect to handle OpenCV.js initialization
    useEffect(() => {
        const initializeCv = async () => {
            try {
                // Promiseが解決されるのを待ち、解決されたcvオブジェクトをrefに格納します。
                cvRef.current = await cvReadyPromise;
                console.log("OpenCV.js is ready!");
                // ビルド情報をログに出力して、正しくロードされたことを確認します。
                console.log(cvRef.current.getBuildInformation());
                setIsCvReady(true);
            } catch (error) {
                console.error("Error initializing OpenCV.js", error);
            }
        };
        initializeCv();
    }, []);

    // Effect to pre-process images for table display
    useEffect(() => {
        // OpenCV.jsの準備が完了し、画像がキャプチャされるまで待機します
        if (!isCvReady || !capturedImage || !canvasRef.current) return;

        const cv = cvRef.current;
        if (!cv) return;

        // Create a single Mat from the clean capturedImage
        const fullSrcMat = cv.matFromImageData(capturedImage);

        const urls = selections.map(rect => {
            const processPart = (x: number, y: number, width: number, height: number): string => {
                if (!fullSrcMat || fullSrcMat.empty()) return '';
                if (width <= 0 || height <= 0 || rect.scaleX <= 0 || rect.scaleY <= 0) {
                    return '';
                }

                if (x + width > fullSrcMat.cols || y + height > fullSrcMat.rows) {
                    return '';
                }

                let src = null;
                let dst = null;
                try {
                    src = fullSrcMat.roi(new cv.Rect(x, y, width, height));
                    if (rect.label === 'DIFFICULTY') {
                        const hsv = new cv.Mat();
                        cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
                        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

                        const mask = new cv.Mat();
                        const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, rect.threshold, 0, 0]);
                        const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 255, 255, 255]);
                        cv.inRange(hsv, low, high, mask);

                        dst = new cv.Mat();
                        cv.bitwise_and(src, src, dst, mask);

                        // Find contours to crop the image to the visible part
                        const contours = new cv.MatVector();
                        const hierarchy = new cv.Mat();
                        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
                        if (contours.size() > 0) {
                            // @ts-expect-error ごめんね
                            let x_min = canvasRef.current.width, y_min = canvasRef.current.height, x_max = 0, y_max = 0;
                            for (let i = 0; i < contours.size(); ++i) {
                                const rect = cv.boundingRect(contours.get(i));
                                x_min = Math.min(x_min, rect.x);
                                y_min = Math.min(y_min, rect.y);
                                x_max = Math.max(x_max, rect.x + rect.width);
                                y_max = Math.max(y_max, rect.y + rect.height);
                            }
                            if (x_max > x_min && y_max > y_min) {
                                const rect = new cv.Rect(x_min, y_min, x_max - x_min, y_max - y_min);
                                const clippedDst = dst.roi(rect);
                                // Replace dst with the clipped version
                                dst.delete();
                                dst = clippedDst;
                            }
                        }
                        contours.delete();
                        hierarchy.delete();

                        hsv.delete();
                        mask.delete();
                        low.delete();
                        high.delete();
                    } else {
                        dst = new cv.Mat();
                        const dsize = new cv.Size(Math.round(width * rect.scaleX), Math.round(height * rect.scaleY));
                        cv.resize(src, dst, dsize, 0, 0, cv.INTER_LANCZOS4);
                        cv.cvtColor(dst, dst, cv.COLOR_RGBA2GRAY, 0);
                        const thresholdType = rect.negative ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY;
                        cv.threshold(dst, dst, rect.threshold, 255, thresholdType);
                    }
                    const tempCanvas = document.createElement('canvas');
                    cv.imshow(tempCanvas, dst);
                    return tempCanvas.toDataURL();
                } finally {
                    src?.delete();
                    dst?.delete();
                }
            };

            const result: { integer: string, decimal?: string } = {
                integer: processPart(rect.x, rect.y, rect.width, rect.height)
            };

            const isSplit = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN'].includes(rect.label);
            if (isSplit && rect.x2 !== undefined && rect.y2 !== undefined && rect.width2 !== undefined && rect.height2 !== undefined) {
                result.decimal = processPart(rect.x2, rect.y2, rect.width2, rect.height2);
            }

            return result;
        });
        setProcessedImages(urls);
        // Clean up the full Mat
        fullSrcMat.delete();

    }, [selections, capturedImage, isCvReady]);


    // Effect to draw on main canvas
    useEffect(() => {
        if (!capturedImage || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        context.putImageData(capturedImage, 0, 0);
        context.lineWidth = 2;

        const isSplitLabel = (label: string) => ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN'].includes(label);

        selections.forEach((rect, index) => {
            // Draw integer part
            if (redrawTarget?.index === index && redrawTarget.part === 'integer') context.strokeStyle = 'orange';
            else context.strokeStyle = 'blue';
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);

            // Draw decimal part
            if (isSplitLabel(rect.label) && rect.x2 !== undefined && rect.y2 !== undefined && rect.width2 !== undefined && rect.height2 !== undefined) {
                if (redrawTarget?.index === index && redrawTarget.part === 'decimal') context.strokeStyle = 'orange';
                else context.strokeStyle = 'cyan';
                context.strokeRect(rect.x2, rect.y2, rect.width2, rect.height2);
            }
        });

        // Draw perspective points and lines ONLY when setting them
        // The result of the transform is already on the canvas.
        if (isSettingPerspective && perspectivePoints.length > 0) {
            context.strokeStyle = 'lime';
            context.fillStyle = 'lime';
            context.lineWidth = 1;
            context.beginPath();
            const [start, ...rest] = perspectivePoints;
            context.moveTo(start.x, start.y);
            rest.forEach(p => context.lineTo(p.x, p.y));
            if (perspectivePoints.length === 4) {
                context.closePath();
            }
            context.stroke();

            perspectivePoints.forEach((p, i) => {
                context.beginPath();
                context.arc(p.x, p.y, 5, 0, 2 * Math.PI);
                context.fill();
                context.fillText(`${i + 1}`, p.x + 8, p.y + 8);
            });
        }

        if (isDrawing && startPoint && endPoint) {
            context.strokeStyle = 'red';
            context.strokeRect(startPoint.x, startPoint.y, endPoint.x - startPoint.x, endPoint.y - startPoint.y);
        }
    }, [capturedImage, selections, isDrawing, startPoint, endPoint, redrawTarget, isSettingPerspective, perspectivePoints]);

    return (
        <div className="App">
            <header className="App-header">
                <h1>Video OCR</h1>
                {showMasterDataInput && (
                    <div style={{
                        margin: '10px 0',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        maxWidth: '700px',
                        width: '100%'
                    }}>
                        <a href={"https://asia-northeast1-iidx-viewer.cloudfunctions.net/getMasterData"}
                           target={"_blank"}>マスタデータ</a>
                        <textarea rows={5}
                                  placeholder='上記リンクの内容をすべて選択してコピペしてください'
                                  value={masterDataJson} onChange={(e) => setMasterDataJson(e.target.value)}
                                  style={{width: '100%', padding: '5px'}}/>
                        <button onClick={handleLoadMasterData}
                                style={{alignSelf: 'flex-start'}}>マスタデータを読み込む
                        </button>
                    </div>
                )}
                <div style={{
                    margin: '20px 0',
                    borderTop: '1px solid #444',
                    paddingTop: '20px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    maxWidth: '700px',
                    width: '100%'
                }}>
                    <h4>設定のエクスポート/インポート</h4>
                    <textarea
                        rows={8}
                        placeholder='ここに設定JSONを貼り付けてインポート、またはエクスポートされた設定が表示されます。'
                        value={settingsJson}
                        onChange={(e) => setSettingsJson(e.target.value)}
                        style={{width: '100%', padding: '5px', fontFamily: 'monospace'}}
                    />
                    <div style={{display: 'flex', gap: '10px'}}>
                        <button onClick={handleExportSettings}>設定をエクスポート</button>
                        <button onClick={handleImportSettings}>設定をインポート</button>
                    </div>
                </div>
                <input type="file" accept="video/*" onChange={handleFileChange} style={{width: "-webkit-fill-available"}}/>
                {videoSrc && (
                    <div>
                        <video ref={videoRef} controls src={videoSrc} onSeeked={captureFrame}
                               style={{width: '100%', maxWidth: '700px', marginTop: '20px'}}/>
                        <div style={{
                            marginTop: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            flexWrap: 'wrap'
                        }}>
                            <button onClick={handleSettingPerspective} disabled={!videoSrc || isSettingPerspective}>
                                台形補正範囲を設定
                            </button>
                            <label style={{marginLeft: '10px'}}>
                                {isSettingPerspective ? `点をクリックしてください (${perspectivePoints.length}/4)` : `${perspectivePoints.length === 4 ? '設定済' : '未設定'}`}
                                {perspectivePoints.length === 4 && perspectivePoints.map((p) =>
                                    (`(${p.x.toFixed(0)},${p.y.toFixed(0)})`)).join(", ")}
                            </label>
                            <label style={{marginLeft: '20px'}}>
                                プレースタイル:
                                <label style={{marginLeft: '5px'}}><input type="radio" name="playStyle" value={1} checked={playStyle === 1} onChange={(e) => setPlayStyle(parseInt(e.target.value, 10))} /> SP</label>
                                <label style={{marginLeft: '5px'}}><input type="radio" name="playStyle" value={2} checked={playStyle === 2} onChange={(e) => setPlayStyle(parseInt(e.target.value, 10))} /> DP</label>
                            </label>
                        </div>
                        <div style={{
                            marginTop: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            flexWrap: 'wrap'
                        }}>
                            <button onClick={() => handleSeek(-1)}>1秒戻る (D)</button>
                            <button onClick={() => handleSeek(-(1 / frameRate))}>1F戻る (F)</button>
                            <button onClick={() => handleSeek(1 / frameRate)}>1F進む (J)</button>
                            <button onClick={() => handleSeek(1)}>1秒進む (K)</button>
                            <label style={{marginLeft: '10px'}}>
                                FPS:
                                <input type="number" value={frameRate}
                                       onChange={(e) => setFrameRate(parseInt(e.target.value, 10) || 60)} min={1}
                                       style={{width: '50px', marginLeft: '5px'}}/>
                            </label>
                        </div>
                        <div style={{
                            marginTop: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            flexWrap: 'wrap'
                        }}>
                            <button onClick={() => {
                                const newIsSeeking = !isSeeking;
                                setIsSeeking(newIsSeeking);
                                isSeekingRef.current = newIsSeeking;
                                if (newIsSeeking) {
                                    findNextChange();
                                }
                            }} disabled={!capturedImage}>
                                {isSeeking ? '停止 (L)' : '次の曲を自動検出 (L)'}
                            </button>
                            <label>
                                変化の閾値:
                                <input type="number" value={diffThreshold} min={1} max={255}
                                       onChange={(e) => setDiffThreshold(parseInt(e.target.value, 10) || 20)}
                                       style={{width: '50px', marginLeft: '5px'}}/>
                            </label>
                            <label>
                                検知後のフレームスキップ数:
                                <input type="number" value={skipFramesAfterChange} min={0}
                                       onChange={(e) => setSkipFramesAfterChange(parseInt(e.target.value, 10) || 0)}
                                       style={{width: '50px', marginLeft: '5px'}}/>
                            </label>
                            <label>
                                自動OCR:
                                <input
                                    type="checkbox"
                                    checked={autoOcrAfterChange}
                                    onChange={(e) => setAutoOcrAfterChange(e.target.checked)}
                                    style={{marginLeft: '5px'}}/>
                            </label>
                        </div>
                        <div style={{
                            marginTop: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            flexWrap: 'wrap'
                        }}>
                            {capturedImage && (
                                <>
                                    <button onClick={runOCR} disabled={isOcrRunning || selections.length === 0}
                                            style={{marginLeft: '10px'}}>
                                        {isOcrRunning ? '実行中...' : 'OCR実行 (Space)'}
                                    </button>
                                    <label>
                                        閾値ステップ:
                                        <input type="number" value={thresholdStep} min={1}
                                               onChange={(e) => setThresholdStep(parseInt(e.target.value, 10) || 1)}
                                               style={{width: '50px', marginLeft: '5px'}}/>
                                    </label>
                                    <label>
                                        OCR試行回数:
                                        <input type="number" value={ocrImageCount} min={1}
                                               onChange={(e) => setOcrImageCount(parseInt(e.target.value, 10) || 1)}
                                               style={{width: '50px', marginLeft: '5px'}}/>
                                    </label>
                                    <button onClick={handleAddToOutput} style={{marginLeft: '10px'}}>
                                        出力に追加 (Enter)
                                    </button>
                                    {addOutputMessage && <span style={{
                                        marginLeft: '10px',
                                        color: addOutputMessageType === 'success' ? 'lightgreen' : 'red'
                                    }}>{addOutputMessage}</span>}
                                </>
                            )}
                        </div>
                        {selections.length > 0 && ( // This block renders the Selections table
                            <div style={{marginTop: '20px'}}>
                                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                                    <h3>Selections</h3>
                                    <button onClick={() => setShowSelectionDetails(!showSelectionDetails)} style={{padding: '0.2em 0.8em'}}>
                                        {showSelectionDetails ? '設定を隠す' : '設定を表示'}
                                    </button>
                                </div>
                                <table border={1}
                                       style={{width: '100%', maxWidth: '700px', borderCollapse: 'collapse'}}>
                                    <thead>
                                    <tr>
                                        <th>項目名</th>
                                        {showSelectionDetails && (
                                            <>
                                                <th>Action</th>
                                                <th>X</th>
                                                <th>Y</th>
                                                <th>Width</th>
                                                <th>Height</th>
                                                <th>Threshold</th>
                                                <th>Scale X</th>
                                                <th>Scale Y</th>
                                            </>
                                        )}
                                        <th>入力画像</th>
                                        <th>OCR結果</th>
                                        <th>補正値</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    {selections.map((rect, index) => {
                                        const currentCorrection = selectedCorrections[index] ?? '';
                                        const manualSuggestions = currentCorrection.length > 1
                                            ? titleMasterData
                                                .filter(item => item.title.toLowerCase().includes(currentCorrection.toLowerCase()))
                                                .slice(0, 10)
                                            : [];

                                        return (
                                            <tr key={index}>
                                                <td>
                                                    {rect.label}
                                                </td>
                                                {showSelectionDetails && (() => {
                                                    const isSplit = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN'].includes(rect.label);
                                                    return (
                                                        <>
                                                            <td style={{textAlign: 'center', whiteSpace: 'nowrap'}}>
                                                                <button onClick={() => handleRedraw(index, 'integer')}
                                                                        disabled={redrawTarget !== null || isSettingPerspective}
                                                                        style={{display: "block"}}
                                                                >
                                                                    {redrawTarget?.index === index && redrawTarget?.part === 'integer' ? '設定中' : (isSplit ? '整数部' : '範囲設定')}
                                                                </button>
                                                                {isSplit && (
                                                                    <button onClick={() => handleRedraw(index, 'decimal')}
                                                                            disabled={redrawTarget !== null || isSettingPerspective}
                                                                            style={{display: "block"}}
                                                                    >
                                                                        {redrawTarget?.index === index && redrawTarget?.part === 'decimal' ? '設定中' : '小数部'}
                                                                    </button>
                                                                )}
                                                            </td>
                                                            <td><input type="number" value={rect.x}
                                                                       onChange={(e) => handleSelectionParamChange(index, 'x', parseInt(e.target.value, 10) || 0)}
                                                                       style={{width: '50px'}}/>
                                                                {isSplit && (
                                                                    <input type="number" value={rect.x2}
                                                                           onChange={(e) => handleSelectionParamChange(index, 'x2', parseInt(e.target.value, 10) || 0)}
                                                                           style={{width: '50px'}}/>
                                                                )}
                                                            </td>
                                                            <td><input type="number" value={rect.y}
                                                                       onChange={(e) => handleSelectionParamChange(index, 'y', parseInt(e.target.value, 10) || 0)}
                                                                       style={{width: '50px'}}/>
                                                                {isSplit && (
                                                                    <input type="number" value={rect.y2}
                                                                           onChange={(e) => handleSelectionParamChange(index, 'y2', parseInt(e.target.value, 10) || 0)}
                                                                           style={{width: '50px'}}/>
                                                                )}
                                                            </td>
                                                            <td><input type="number" value={rect.width}
                                                                       onChange={(e) => handleSelectionParamChange(index, 'width', parseInt(e.target.value, 10) || 0)}
                                                                       style={{width: '50px'}}/>
                                                                {isSplit && (
                                                                    <input type="number" value={rect.width2}
                                                                           onChange={(e) => handleSelectionParamChange(index, 'width2', parseInt(e.target.value, 10) || 0)}
                                                                           style={{width: '50px'}}/>
                                                                )}
                                                            </td>
                                                            <td><input type="number" value={rect.height}
                                                                       onChange={(e) => handleSelectionParamChange(index, 'height', parseInt(e.target.value, 10) || 0)}
                                                                       style={{width: '50px'}}/>
                                                                {isSplit && (
                                                                    <input type="number" value={rect.height2}
                                                                           onChange={(e) => handleSelectionParamChange(index, 'height2', parseInt(e.target.value, 10) || 0)}
                                                                           style={{width: '50px'}}/>
                                                                )}
                                                            </td>
                                                        </>
                                                    );
                                                })()}
                                                {showSelectionDetails && (
                                                    <>
                                                        <td>
                                                            <input type="number" value={rect.threshold}
                                                                   onChange={(e) => handleSelectionParamChange(index, 'threshold', parseInt(e.target.value, 10))}
                                                                   min={0} max={255} style={{width: '50px'}}/>
                                                        </td>
                                                        <td>
                                                            <input type="number" value={rect.scaleX}
                                                                   onChange={(e) => handleSelectionParamChange(index, 'scaleX', parseFloat(e.target.value))}
                                                                   min={0.1} step={0.1} style={{width: '35px'}}/>
                                                        </td>
                                                        <td>
                                                            <input type="number" value={rect.scaleY}
                                                                   onChange={(e) => handleSelectionParamChange(index, 'scaleY', parseFloat(e.target.value))}
                                                                   min={0.1} step={0.1} style={{width: '35px'}}/>
                                                        </td>
                                                    </>
                                                )}
                                                <td>
                                                    <div style={{
                                                        width: "600px",
                                                        overflowX: "auto",
                                                        whiteSpace: "nowrap"
                                                    }}>
                                                        {processedImages[index]?.integer &&
                                                            <img src={processedImages[index].integer}
                                                                 alt={`Processed integer part ${index + 1}`}
                                                            />
                                                        }
                                                        {processedImages[index]?.decimal &&
                                                            <img src={processedImages[index].decimal}
                                                                 alt={`Processed decimal part ${index + 1}`} style={{marginLeft: '5px'}}
                                                            />
                                                        }
                                                    </div>
                                                </td>
                                                <td style={{whiteSpace: "pre"}}>
                                                    {typeof ocrResults[index] === 'object' && ocrResults[index] !== null
                                                        // @ts-expect-error ごめんね
                                                        ? `EN: ${ocrResults[index].eng}\nJP: ${ocrResults[index].jpn}`
                                                        : ocrResults[index] || ''}
                                                </td>
                                                <td>
                                                    {selections[index].label === 'TITLE' ? (
                                                        <div style={{
                                                            display: 'flex',
                                                            flexDirection: 'column',
                                                            gap: '5px'
                                                        }}>
                                                            {correctionSuggestions[index]?.length > 0 && (
                                                                <select
                                                                    value={selectedCorrectionIds[index] ?? ''}
                                                                    onChange={(e) => {
                                                                        const newId = parseInt(e.target.value, 10);
                                                                        const selectedItem = titleMasterData.find(item => item.id === newId);
                                                                        if (selectedItem) {
                                                                            const newSelected = [...selectedCorrections];
                                                                            newSelected[index] = selectedItem.title;
                                                                            setSelectedCorrections(newSelected);

                                                                            const newIds = [...selectedCorrectionIds];
                                                                            newIds[index] = selectedItem.id;
                                                                            setSelectedCorrectionIds(newIds);
                                                                        }
                                                                    }}
                                                                >
                                                                    {correctionSuggestions[index]?.map((suggestion) => (
                                                                        <option key={suggestion.id}
                                                                                value={suggestion.id}>
                                                                            {suggestion.title} (dist: {suggestion.distance}, {suggestion.titleDistance}+{suggestion.artistDistance})
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                            )}
                                                            <input
                                                                type="text"
                                                                list={`manual-suggestions-${index}`}
                                                                placeholder="または手動で入力"
                                                                value={currentCorrection}
                                                                onChange={(e) => {
                                                                    const newSelected = [...selectedCorrections];
                                                                    const newTitle = e.target.value;
                                                                    newSelected[index] = newTitle;
                                                                    setSelectedCorrections(newSelected);

                                                                    const newIds = [...selectedCorrectionIds];
                                                                    const matchedItem = titleMasterData.find(item => item.title === newTitle);
                                                                    newIds[index] = matchedItem?.id ?? null;
                                                                    setSelectedCorrectionIds(newIds);
                                                                }}
                                                            />
                                                            <datalist id={`manual-suggestions-${index}`}>
                                                                {manualSuggestions.map((suggestion) => (
                                                                    <option key={suggestion.id}
                                                                            value={suggestion.title}/>
                                                                ))}
                                                            </datalist>
                                                            {correctionInputErrors[index] && <span style={{
                                                                color: 'red',
                                                                fontSize: '0.9em'
                                                            }}>{correctionInputErrors[index]}</span>}
                                                        </div>
                                                    ) : selections[index].label === 'DIFFICULTY' ? (
                                                        <div style={{whiteSpace: 'nowrap'}}>
                                                            {['B', 'N', 'H', 'A', 'L'].map(level => (
                                                                <label key={level} style={{marginRight: '5px'}}>
                                                                    <input
                                                                        type="radio"
                                                                        name={`difficulty-${index}`}
                                                                        value={level}
                                                                        checked={selectedCorrections[index] === level}
                                                                        onChange={(e) => {
                                                                            const newSelected = [...selectedCorrections];
                                                                            newSelected[index] = e.target.value;
                                                                            setSelectedCorrections(newSelected);
                                                                        }}
                                                                    />
                                                                    {level}
                                                                </label>
                                                            ))}
                                                        </div>
                                                    ) : selections[index].label === 'ARTIST' ? (<>
                                                        {titleMasterData.find(s => s.id === selectedCorrectionIds[0])?.artist}
                                                    </>): (
                                                        <div style={{
                                                            display: 'flex',
                                                            flexDirection: 'column',
                                                            gap: '5px'
                                                        }}>
                                                            <input
                                                                type="text"
                                                                value={selectedCorrections[index] || ''}
                                                                onChange={(e) => {
                                                                    const newSelected = [...selectedCorrections];
                                                                    newSelected[index] = e.target.value;
                                                                    setSelectedCorrections(newSelected);
                                                                }}
                                                                style={{maxWidth: '300px', fontSize : "60px"}}/>
                                                            {correctionInputErrors[index] && <span style={{
                                                                color: 'red',
                                                                fontSize: '0.9em'
                                                            }}>{correctionInputErrors[index]}</span>}
                                                        </div>
                                                    )
                                                    }
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <canvas
                            ref={canvasRef}
                            style={{
                                marginTop: '20px',                                 maxWidth: '100%',
                                border: '1px solid black',
                                cursor: (redrawTarget !== null || isSettingPerspective) ? 'crosshair' : 'default'
                            }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp}
                            onMouseLeave={handleMouseUp}
                        />
                    </div>
                )}

                {outputData.length > 0 && (
                    <div style={{marginTop: '20px', width: '100%', maxWidth: '700px'}}>
                        <h3>Output Data</h3>
                        <textarea
                            readOnly
                            rows={10}
                            value={JSON.stringify({data: outputData}, null, 2)}
                            style={{width: '100%', fontFamily: 'monospace'}}
                        />
                        <>
                            <button onClick={handleDownloadJson} style={{marginTop: '5px'}}>
                                JSONをダウンロード
                            </button>
                        </>
                    </div>
                )}
            </header>
        </div>
    );
}
