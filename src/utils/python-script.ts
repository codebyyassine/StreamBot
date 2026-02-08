import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Execute a Python script and capture its output
 *
 * @param scriptName - Name of the Python script file (relative to src/scripts/)
 * @param args - Arguments to pass to the Python script
 * @param timeout - Optional timeout in milliseconds (default: 30000)
 * @returns Object containing stdout and stderr
 * @throws Error if execution fails or times out
 */
export async function executePythonScript(
	scriptName: string,
	args: string[],
	timeout: number = 30000
): Promise<{ stdout: string; stderr: string }> {
	try {
		const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);
		logger.debug(`Executing Python script: ${scriptPath} ${args.join(' ')}`);

		// Build the command - escape arguments with spaces
		const escapedArgs = args.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			return arg;
		});

		const command = `python "${scriptPath}" ${escapedArgs.join(' ')}`;

		const { stdout, stderr } = await execAsync(command, {
			timeout,
			windowsHide: true, // Hide console window on Windows
		});

		if (stderr) {
			logger.warn(`Python script stderr: ${stderr}`);
		}

		return { stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error: any) {
		// Handle timeout specifically
		if (error.killed && error.signal === 'SIGTERM') {
			logger.error(`Python script timed out after ${timeout}ms`);
			throw new Error(`Python script execution timed out after ${timeout}ms`);
		}

		// Handle other errors
		const errorMessage = error.stderr || error.message || 'Unknown error';
		logger.error(`Failed to execute Python script: ${errorMessage}`);
		throw error;
	}
}

/**
 * Check if Python is available and the required script exists
 *
 * @param scriptName - Name of the Python script to check
 * @returns true if Python and script are available
 */
export async function checkPythonEnvironment(scriptName: string): Promise<boolean> {
	try {
		const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);
		const { stdout } = await execAsync('python --version', { timeout: 5000 });
		logger.info(`Python available: ${stdout.trim()}`);

		// Try to run the script with --help or just check if it exists
		const fs = await import('fs');
		if (fs.existsSync(scriptPath)) {
			logger.info(`Python script found: ${scriptPath}`);
			return true;
		}

		logger.warn(`Python script not found: ${scriptPath}`);
		return false;
	} catch (error: any) {
		logger.warn(`Python not available or script missing: ${error.message}`);
		return false;
	}
}
