import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, NativeModules, Alert } from 'react-native';
import * as Speech from 'expo-speech';
import { RekognitionClient, DetectLabelsCommand } from '@aws-sdk/client-rekognition';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const { ARKitDepthModule, CameraModule } = NativeModules;

// AWS Configuration - Keys should be in .env file
const AWS_CONFIG = {
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'YOUR_ACCESS_KEY_HERE',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'YOUR_SECRET_KEY_HERE',
  },
  region: process.env.AWS_REGION || 'us-east-1',
};

const rekognitionClient = new RekognitionClient(AWS_CONFIG);
const s3Client = new S3Client(AWS_CONFIG);
const S3_BUCKET = process.env.AWS_S3_BUCKET || 'your-bucket-name';

export default function HomeScreen() {
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState('');
  const [hasLiDAR, setHasLiDAR] = useState(false);
  const [arSessionActive, setArSessionActive] = useState(false);

  useEffect(() => {
    checkLiDAR();
    return () => {
      if (arSessionActive && ARKitDepthModule) {
        ARKitDepthModule.stopDepthSession();
      }
    };
  }, []);

  const checkLiDAR = async () => {
    if (ARKitDepthModule) {
      try {
        const available = await ARKitDepthModule.isLiDARAvailable();
        setHasLiDAR(available);
        if (available) {
          await ARKitDepthModule.startDepthSession();
          setArSessionActive(true);
          console.log('✅ LiDAR available and session started');
        }
      } catch (error) {
        console.log('❌ ARKit error:', error);
      }
    }
  };

  const base64ToUint8Array = (base64: string): Uint8Array => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const speakText = async (text: string) => {
    try {
      console.log('🔊 Attempting to speak:', text);
      await Speech.stop();
      
      // Speak with maximum volume and settings
      await Speech.speak(text, {
        rate: 0.85,
        pitch: 1.0,
        volume: 1.0, // Maximum volume
        language: 'en-US',
        _voiceIndex: 0,
      });
      
      console.log('✅ Speech command sent');
    } catch (error) {
      console.error('❌ TTS Error:', error);
      // Show alert if TTS fails
      Alert.alert('TTS Error', `Could not speak: ${error.message}`);
    }
  };

  const getARKitDistance = async (): Promise<number | null> => {
    if (!hasLiDAR || !ARKitDepthModule) {
      return null;
    }

    try {
      const depthData = await ARKitDepthModule.getDepthAtCenter();
      return depthData.distance;
    } catch (error) {
      console.log('Could not get ARKit depth:', error);
      return null;
    }
  };

  const takePicture = async () => {
    if (analyzing || !CameraModule) return;

    setAnalyzing(true);
    await speakText('Opening camera');

    try {
      console.log('📸 Opening native camera...');
      const photo = await CameraModule.takePicture();
      
      if (!photo || !photo.base64) {
        throw new Error('No image data');
      }
      
      console.log('✅ Photo captured, base64 length:', photo.base64.length);
      
      setResult('Analyzing image...');
      await speakText('Analyzing');

      const timestamp = Date.now();
      const key = `analysis/${timestamp}.jpg`;
      const imageBytes = base64ToUint8Array(photo.base64);

      // Upload to S3
      const uploadCommand = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: imageBytes,
        ContentType: 'image/jpeg',
      });

      await s3Client.send(uploadCommand);

      // Analyze with Rekognition
      const detectCommand = new DetectLabelsCommand({
        Image: {
          S3Object: {
            Bucket: S3_BUCKET,
            Name: key,
          },
        },
        MaxLabels: 10,
        MinConfidence: 70,
      });

      const rekognitionResult = await rekognitionClient.send(detectCommand);
      const allLabels = rekognitionResult.Labels || [];
      
      // Filter out abstract/scene categories - keep only physical objects
      const excludeCategories = [
        'interior design', 'architecture', 'room', 'indoors', 'outdoors',
        'building', 'floor', 'wall', 'ceiling', 'flooring', 'hardwood',
        'wood', 'lighting', 'urban', 'city', 'nature', 'scenery', 'landscape',
        'housing', 'shelter', 'home decor', 'art', 'modern art', 'abstract'
      ];
      
      const physicalObjects = allLabels.filter(label => {
        const name = label.Name?.toLowerCase() || '';
        // Exclude abstract categories
        if (excludeCategories.some(cat => name.includes(cat))) {
          return false;
        }
        // Only include labels with instances (actual detected objects with bounding boxes)
        return label.Instances && label.Instances.length > 0;
      });
      
      // Get real distance from ARKit if available
      let realDistance: number | null = null;
      if (hasLiDAR) {
        realDistance = await getARKitDistance();
      }

      let description = '';
      
      if (physicalObjects.length > 0) {
        const topObjects = physicalObjects.slice(0, 3);
        
        // Announce distance first
        if (realDistance !== null) {
          const distFeet = Math.round(realDistance * 10) / 10;
          description = `Objects are approximately ${distFeet} feet away. `;
        } else {
          description = 'Objects detected. ';
        }
        
        // List each object with its individual distance estimate and direction g
        topObjects.forEach((label, index) => {
          const name = label.Name?.toLowerCase() || 'object';
          
          // Get distance and direction from bounding box
          let objectDistance = '';
          let direction = '';
          
          if (label.Instances && label.Instances.length > 0) {
            const instance = label.Instances[0];
            if (instance.BoundingBox) {
              const box = instance.BoundingBox;
              const boxArea = (box.Width || 0) * (box.Height || 0);
              
              // Estimate distance based on size in frame
              if (boxArea > 0.3) {
                objectDistance = '2 to 3 feet';
              } else if (boxArea > 0.15) {
                objectDistance = '4 to 6 feet';
              } else if (boxArea > 0.08) {
                objectDistance = '8 to 10 feet';
              } else if (boxArea > 0.04) {
                objectDistance = '12 to 15 feet';
              } else {
                objectDistance = 'more than 15 feet';
              }
              
              // Calculate position in frame (0 to 1 coordinates)
              // Left is the X position, Top is the Y position
              const centerX = (box.Left || 0) + (box.Width || 0) / 2;
              const centerY = (box.Top || 0) + (box.Height || 0) / 2;
              
              // Determine horizontal direction
              let horizontal = '';
              if (centerX < 0.3) {
                horizontal = 'on your left';
              } else if (centerX > 0.7) {
                horizontal = 'on your right';
              } else {
                horizontal = 'in front of you';
              }
              
              // Determine vertical direction
              let vertical = '';
              if (centerY < 0.3) {
                vertical = 'above';
              } else if (centerY > 0.7) {
                vertical = 'below';
              }
              
              // Combine directions
              if (vertical && horizontal !== 'in front of you') {
                direction = `${vertical} and ${horizontal}`;
              } else if (vertical) {
                direction = `${vertical} ${horizontal}`;
              } else {
                direction = horizontal;
              }
            }
          }
          
          if (index === 0) {
            description += `I see a ${name}`;
          } else {
            description += `, a ${name}`;
          }
          
          if (objectDistance && !realDistance) {
            description += ` about ${objectDistance} away`;
          }
          
          if (direction) {
            description += ` ${direction}`;
          }
        });
        
        description += '.';
        
      } else {
        description = 'No specific objects detected. Try pointing at a clear object like a person, chair, or bottle.';
      }

      setResult(description);
      await speakText(description);

    } catch (error: any) {
      if (error.code === 'CANCELLED') {
        setResult('');
        setAnalyzing(false);
        return;
      }
      
      const errorDetails = error?.message || error?.toString() || 'Unknown error';
      const errorMsg = `Analysis failed: ${errorDetails}`;
      console.error('❌ Full error:', error);
      setResult(errorMsg);
      await speakText('Analysis failed. Please try again.');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>SeeWithYou</Text>
          {hasLiDAR && (
            <View style={styles.lidarBadge}>
              <Text style={styles.lidarText}>📡 LiDAR Active</Text>
            </View>
          )}
        </View>

        {result ? (
          <View style={styles.resultContainer}>
            <Text style={styles.resultText}>{result}</Text>
          </View>
        ) : (
          <View style={styles.instructionContainer}>
            <Text style={styles.instructionText}>
              Tap the button to take a picture and analyze your surroundings
            </Text>
            {hasLiDAR && (
              <Text style={styles.instructionSubtext}>
                Using LiDAR for accurate distance measurement
              </Text>
            )}
          </View>
        )}
        
        <View style={styles.controlsContainer}>
          <TouchableOpacity
            style={[styles.captureButton, analyzing && styles.captureButtonDisabled]}
            onPress={takePicture}
            disabled={analyzing}
            accessibilityLabel="Take picture and analyze"
          >
            {analyzing ? (
              <ActivityIndicator size="large" color="white" />
            ) : (
              <Text style={styles.captureButtonText}>📸</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.buttonLabel}>
            {analyzing ? 'Analyzing...' : 'Tap to Analyze'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 50,
  },
  header: {
    alignItems: 'center',
    padding: 20,
  },
  title: {
    color: 'white',
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  lidarBadge: {
    backgroundColor: 'rgba(0, 255, 0, 0.3)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#00ff00',
  },
  lidarText: {
    color: '#00ff00',
    fontSize: 14,
    fontWeight: 'bold',
  },
  instructionContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    padding: 20,
    margin: 20,
    borderRadius: 15,
  },
  instructionText: {
    color: 'white',
    fontSize: 18,
    textAlign: 'center',
    lineHeight: 26,
  },
  instructionSubtext: {
    color: '#00ff00',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 10,
  },
  resultContainer: {
    backgroundColor: 'rgba(0, 122, 255, 0.2)',
    padding: 25,
    margin: 20,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: '#007AFF',
  },
  resultText: {
    color: 'white',
    fontSize: 20,
    textAlign: 'center',
    lineHeight: 30,
    fontWeight: '500',
  },
  controlsContainer: {
    alignItems: 'center',
  },
  captureButton: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
  },
  captureButtonDisabled: {
    backgroundColor: '#666',
    shadowColor: '#000',
  },
  captureButtonText: {
    fontSize: 45,
  },
  buttonLabel: {
    color: 'white',
    fontSize: 18,
    marginTop: 15,
    fontWeight: '600',
  },
});
