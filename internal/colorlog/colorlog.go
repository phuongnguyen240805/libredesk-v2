// package colorlog provides ANSI color logging for the terminal.
package colorlog

import "log"

const (
	ANSIColourGreen = "\x1b[32m"
	ANSIColourRed   = "\x1b[31m"
)

// Green logs messages in green color.
func Green(format string, v ...interface{}) {
	log.Printf("%s"+format+"\x1b[0m", append([]interface{}{ANSIColourGreen}, v...)...)
}

// Red logs messages in red color.
func Red(format string, v ...interface{}) {
	log.Printf("%s"+format+"\x1b[0m", append([]interface{}{ANSIColourRed}, v...)...)
}
