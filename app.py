try:
    from wirewatch.main_window import run
except ImportError:
    from src.wirewatch.main_window import run

if __name__ == "__main__":
    run()
